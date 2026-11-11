'use strict';

// Minimal Wyoming protocol client (https://github.com/rhasspy/wyoming), no dependency.
//
// An event is a JSON line { type, version, data_length?, payload_length? },
// followed by data_length bytes of JSON data, then payload_length bytes of payload (audio).
//
// Used by dknr-voice to talk to wyoming-vosk (speech to text) and wyoming-piper (text to speech).

const net = require('net');

const VERSION = '1.8.0';

// encode one event to a Buffer
function encode(type, data, payload) {
    const header = { 'type': type, 'version': VERSION };
    const parts = [];
    let dataBytes = null;
    if (data && Object.keys(data).length > 0) {
        dataBytes = Buffer.from(JSON.stringify(data), 'utf8');
        header.data_length = dataBytes.length;
    }
    if (payload && payload.length > 0) {
        header.payload_length = payload.length;
    }
    parts.push(Buffer.from(JSON.stringify(header) + '\n', 'utf8'));
    if (dataBytes) {
        parts.push(dataBytes);
    }
    if (payload && payload.length > 0) {
        parts.push(payload);
    }

    return Buffer.concat(parts);
}

// incremental decoder: push received bytes, get complete events
class Decoder {
    constructor() {
        this.buffer = Buffer.alloc(0);
        this.header = null;
    }

    push(chunk) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        const events = [];
        for (;;) {
            if (this.header === null) {
                const nl = this.buffer.indexOf(0x0a);
                if (nl < 0) {
                    break;
                }
                const line = this.buffer.subarray(0, nl).toString('utf8');
                this.buffer = this.buffer.subarray(nl + 1);
                if (line.trim() === '') {
                    continue;
                }
                this.header = JSON.parse(line);
            }
            const dataLength = this.header.data_length || 0;
            const payloadLength = this.header.payload_length || 0;
            if (this.buffer.length < dataLength + payloadLength) {
                break;
            }
            const data = Object.assign({}, this.header.data || {});
            if (dataLength > 0) {
                Object.assign(data, JSON.parse(this.buffer.subarray(0, dataLength).toString('utf8')));
            }
            const payload = payloadLength > 0 ? Buffer.from(this.buffer.subarray(dataLength, dataLength + payloadLength)) : null;
            this.buffer = this.buffer.subarray(dataLength + payloadLength);
            events.push({ 'type': this.header.type, 'data': data, 'payload': payload });
            this.header = null;
        }

        return events;
    }
}

// "host:port", "tcp://host:port" or { host, port }
function address(uri, defaultPort) {
    if (typeof uri === 'object' && uri !== null) {
        return { 'host': uri.host, 'port': Number(uri.port) || defaultPort };
    }
    const s = String(uri || '').replace(/^tcp:\/\//, '');
    const i = s.lastIndexOf(':');
    if (i < 0) {
        return { 'host': s, 'port': defaultPort };
    }

    return { 'host': s.slice(0, i), 'port': Number(s.slice(i + 1)) || defaultPort };
}

// open a connection, call onEvent(event) for each received event
function connect(uri, defaultPort, onEvent, onClose) {
    const addr = address(uri, defaultPort);
    const decoder = new Decoder();
    const socket = net.createConnection(addr);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
        let events;
        try {
            events = decoder.push(chunk);
        } catch (err) {
            socket.destroy(err);

            return;
        }
        for (const e of events) {
            onEvent(e);
        }
    });
    socket.on('close', () => onClose && onClose());

    return {
        'socket': socket,
        'send': (type, data, payload) => socket.write(encode(type, data, payload)),
        'close': () => socket.end()
    };
}

// Speech to text session (wyoming-vosk: tcp port 10300).
//   const stt = transcribe('vosk:10300', { language: 'fr' });
//   stt.write(pcm16k);  // raw PCM, 16 kHz, 16 bits, mono (default format)
//   const result = await stt.end();  // { text, chunks }
// options.onChunk(text): partial transcript, while speaking (transcript-chunk)
function transcribe(uri, options) {
    options = options || {};
    const audio = { 'rate': options.rate || 16000, 'width': options.width || 2, 'channels': options.channels || 1 };
    const timeout = options.timeout || 15000;
    const chunks = [];
    let resolveResult, rejectResult;
    const result = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    let done = false;
    const finish = (err, value) => {
        if (done) {
            return;
        }
        done = true;
        clearTimeout(timer);
        conn.close();
        if (err) {
            rejectResult(err);
        } else {
            resolveResult(value);
        }
    };
    let timer = null;
    const conn = connect(uri, 10300, (e) => {
        if (e.type === 'transcript-chunk') {
            chunks.push(e.data.text || '');
            if (options.onChunk) {
                options.onChunk(e.data.text || '', chunks.join(''));
            }
        } else if (e.type === 'transcript') {
            finish(null, { 'text': String(e.data.text || '').trim(), 'chunks': chunks.join('') });
        } else if (e.type === 'error') {
            finish(new Error(e.data.text || 'wyoming error'));
        }
    }, () => finish(new Error('connection closed before transcript')));
    conn.socket.on('error', (err) => finish(err));

    const transcribeData = { 'language': options.language || 'fr' };
    if (options.name) {
        transcribeData.name = options.name;
    }
    conn.send('transcribe', transcribeData);
    conn.send('audio-start', Object.assign({ 'timestamp': 0 }, audio));

    let samples = 0;

    return {
        // raw PCM chunk
        'write': (pcm) => {
            if (done || !pcm || pcm.length === 0) {
                return;
            }
            conn.send('audio-chunk', Object.assign({ 'timestamp': Math.round(samples / audio.rate * 1000) }, audio), pcm);
            samples += pcm.length / (audio.width * audio.channels);
        },
        // end of speech: wait for the final transcript
        'end': () => {
            if (!done) {
                conn.send('audio-stop', { 'timestamp': Math.round(samples / audio.rate * 1000) });
                timer = setTimeout(() => finish(new Error('transcript timeout')), timeout);
            }

            return result;
        },
        // give up (no transcript expected)
        'abort': () => finish(new Error('aborted')),
        'result': result
    };
}

// Text to speech (wyoming-piper: tcp port 10200).
//   const { pcm, rate, width, channels } = await synthesize('piper:10200', 'Bonjour', { voice: 'fr_FR-siwis-medium' });
function synthesize(uri, text, options) {
    options = options || {};
    const timeout = options.timeout || 20000;

    return new Promise((resolve, reject) => {
        const parts = [];
        let format = null;
        let done = false;
        const finish = (err, value) => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            conn.close();
            if (err) {
                reject(err);
            } else {
                resolve(value);
            }
        };
        const conn = connect(uri, 10200, (e) => {
            if (e.type === 'audio-start') {
                format = { 'rate': e.data.rate, 'width': e.data.width, 'channels': e.data.channels };
            } else if (e.type === 'audio-chunk') {
                if (format === null) {
                    format = { 'rate': e.data.rate, 'width': e.data.width, 'channels': e.data.channels };
                }
                if (e.payload) {
                    parts.push(e.payload);
                }
            } else if (e.type === 'audio-stop') {
                if (format === null) {
                    finish(new Error('no audio'));

                    return;
                }
                finish(null, Object.assign({ 'pcm': Buffer.concat(parts) }, format));
            } else if (e.type === 'error') {
                finish(new Error(e.data.text || 'wyoming error'));
            }
        }, () => finish(new Error('connection closed before audio-stop')));
        conn.socket.on('error', (err) => finish(err));
        const timer = setTimeout(() => finish(new Error('synthesize timeout')), timeout);

        const data = { 'text': String(text) };
        if (options.voice) {
            data.voice = { 'name': options.voice };
            if (options.speaker) {
                data.voice.speaker = options.speaker;
            }
        }
        conn.send('synthesize', data);
    });
}

// Ask a Wyoming service what it offers (describe / info)
function describe(uri, defaultPort, timeout) {
    return new Promise((resolve, reject) => {
        let done = false;
        const conn = connect(uri, defaultPort, (e) => {
            if (e.type === 'info' && !done) {
                done = true;
                clearTimeout(timer);
                conn.close();
                resolve(e.data);
            }
        }, () => {
            if (!done) {
                done = true;
                clearTimeout(timer);
                reject(new Error('connection closed before info'));
            }
        });
        conn.socket.on('error', (err) => {
            if (!done) {
                done = true;
                clearTimeout(timer);
                reject(err);
            }
        });
        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                conn.socket.destroy();
                reject(new Error('describe timeout'));
            }
        }, timeout || 5000);
        conn.send('describe');
    });
}

// Raw PCM to a WAV file (Buffer)
function wav(pcm, rate, width, channels) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * width * channels, 28);
    header.writeUInt16LE(channels * width, 32);
    header.writeUInt16LE(width * 8, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);

    return Buffer.concat([header, pcm]);
}

// WAV file (Buffer) to { pcm, rate, width, channels }
function readWav(buffer) {
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('not a WAV file');
    }
    let offset = 12;
    let format = null;
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (id === 'fmt ') {
            if (buffer.readUInt16LE(start) !== 1) {
                throw new Error('only PCM WAV files are supported');
            }
            format = {
                'channels': buffer.readUInt16LE(start + 2),
                'rate': buffer.readUInt32LE(start + 4),
                'width': buffer.readUInt16LE(start + 14) / 8
            };
        } else if (id === 'data') {
            if (format === null) {
                throw new Error('WAV data before format');
            }

            return Object.assign({ 'pcm': buffer.subarray(start, start + size) }, format);
        }
        offset = start + size + (size % 2);
    }
    throw new Error('no WAV data');
}

module.exports = { encode, Decoder, connect, transcribe, synthesize, describe, wav, readWav };
