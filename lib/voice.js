'use strict';

// dknr-voice engine: voice devices (ESPHome API) -> speech to text (wyoming-vosk) -> DKNR command (MQTT) -> answer (wyoming-piper)
//
//   const engine = voice.create({ config, publish, valueOf, log, onStatus });
//   engine.start();                  // connect to the voice devices
//   engine.answer('<id>.wav');       // spoken answer served over HTTP to the voice devices
//   engine.test('SET|test|1');       // run a recognized sentence without speaking
//   await engine.close();
//
// config (object or function returning it):
//   vosk: 'host:port' of wyoming-vosk, piper: 'host:port' of wyoming-piper, voice: Piper voice
//   url: base URL of dknr-voice reached by the voice devices (ex: http://10.40.0.10:1880)
//   topic: DKNR MQTT root topic (dknr)
//   response: 'voice' (spoken answer for everything) or 'sound' (short sound for the orders, voice for the questions)
//   satellites: { id: { name, room, host, port, key } }   key: ESPHome API encryption key (base64)
//   devices: { id: { name, room, type, entities: [uid] } }  uid: DKNR entity source/parent/entity
//
// Recognized sentences (the "out" of the sentence templates, see sentences/fr.yaml):
//   SET|<device>|<value>   order to every entity of the device
//   GET|<kind>|<room>      question, answered from the device <kind>_<room> (ex: temperature_salon)
//   anything else          not understood

const path = require('path');
const crypto = require('crypto');
const wyoming = require(path.join(__dirname, 'wyoming.js'));

// ESPHome voice assistant events (api.proto)
const EVENT = {
    'ERROR': 0, 'RUN_START': 1, 'RUN_END': 2, 'STT_START': 3, 'STT_END': 4, 'INTENT_START': 5, 'INTENT_END': 6,
    'TTS_START': 7, 'TTS_END': 8, 'STT_VAD_START': 11, 'STT_VAD_END': 12
};
const API_AUDIO = 1;

// end of speech detection (audio from the voice device: PCM 16 kHz, 16 bits, mono)
const AUDIO = { 'rate': 16000, 'width': 2, 'channels': 1 };
const LISTEN_MAX = 8000;        // ms, longest sentence
const LISTEN_NOTHING = 5000;    // ms, nobody speaks after the wake word
const SILENCE_END = 700;        // ms of silence after speech
const CHUNK_STABLE = 1500;      // ms without new partial transcript after speech (and no loud chunk for 400 ms)
const ANSWER_TTL = 120000;      // ms, a spoken answer is kept for the voice device
const HISTORY = 20;             // last sentences kept for the dashboard

const BOOL_ON = [true, 1, '1', 'true', 'ON', 'on', 'On'];

// root mean square level of a PCM 16 bits chunk
function level(pcm) {
    const n = Math.floor(pcm.length / 2);
    if (n === 0) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const s = pcm.readInt16LE(i * 2);
        sum += s * s;
    }

    return Math.sqrt(sum / n);
}

// short two notes sound (WAV), for the orders when the answer is a sound
function chime() {
    const rate = 22050;
    const notes = [[880, 0.09], [1320, 0.14]];
    const parts = [];
    for (const [freq, seconds] of notes) {
        const n = Math.round(rate * seconds);
        const b = Buffer.alloc(n * 2);
        for (let i = 0; i < n; i++) {
            const fade = Math.min(1, i / 200, (n - i) / 400);
            b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 9000 * fade), i * 2);
        }
        parts.push(b);
    }

    return wyoming.wav(Buffer.concat(parts), rate, 2, 1);
}

// number to French words friendly text (Piper reads "21,5")
function frNumber(value, decimals) {
    const f = Math.pow(10, decimals);

    return String(Math.round(value * f) / f).replace('.', ',');
}

function create(options) {
    const opts = options || {};
    const log = opts.log || { info: console.log, warn: console.warn, error: console.error, debug: () => { } };
    const config = () => (typeof opts.config === 'function' ? opts.config() : opts.config) || {};
    const publish = opts.publish || (() => { });
    const valueOf = opts.valueOf || (() => undefined);
    const onStatus = opts.onStatus || (() => { });
    const clientFactory = opts.clientFactory || (async (o) => {
        const m = await import('esphome-client');

        return new m.EspHomeClient(o);
    });

    const engine = {
        'closed': false,
        'satellites': {},
        'answers': new Map(),
        'history': [],
        'sound': chime()
    };

    // ---- status for the dashboard

    let statusTimer = null;
    function changed() {
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => onStatus(engine.status()), 100);
    }

    engine.status = function () {
        const sats = {};
        for (const id in engine.satellites) {
            const s = engine.satellites[id];
            sats[id] = {
                'name': s.cfg.name || id,
                'room': s.cfg.room || '',
                'host': s.cfg.host || '',
                'state': s.state,
                'error': s.error || '',
                'since': s.since,
                'busy': s.session !== null
            };
        }

        return { 'satellites': sats, 'history': engine.history.slice() };
    };

    function remember(entry) {
        engine.history.unshift(Object.assign({ 'time': Date.now() }, entry));
        engine.history.length = Math.min(engine.history.length, HISTORY);
        changed();
    }

    // ---- spoken answers served over HTTP

    function keep(buffer) {
        const id = crypto.randomBytes(8).toString('hex') + '.wav';
        engine.answers.set(id, { 'buffer': buffer, 'expires': Date.now() + ANSWER_TTL });
        for (const [k, v] of engine.answers) {
            if (v.expires < Date.now()) {
                engine.answers.delete(k);
            }
        }

        return id;
    }

    engine.answer = function (id) {
        const a = engine.answers.get(String(id || ''));

        return a && a.expires >= Date.now() ? a.buffer : null;
    };

    async function speak(text) {
        const cfg = config();
        const audio = await wyoming.synthesize(cfg.piper || 'dknr_voice_piper:10200', text, { 'voice': cfg.voice });

        return keep(wyoming.wav(audio.pcm, audio.rate, audio.width, audio.channels));
    }

    function url(id) {
        return String(config().url || '').replace(/\/+$/, '') + '/voice/answer/' + id;
    }

    // ---- recognized sentence to DKNR command or answer

    function understand(text, satellite) {
        const cfg = config();
        const devices = cfg.devices || {};
        const topic = cfg.topic || 'dknr';
        const m = /^(SET|GET)\|([^|]*)\|(.*)$/.exec(String(text || '').trim());
        if (!m) {
            return { 'ok': false, 'action': '', 'say': 'Je n\'ai pas compris.' };
        }
        const [, action, a, b] = m;

        if (action === 'SET') {
            const device = devices[a];
            if (!device || !Array.isArray(device.entities) || device.entities.length === 0) {
                return { 'ok': false, 'action': 'SET ' + a, 'say': 'Je ne connais pas cet appareil.' };
            }
            const out = device.entities.map(uid => ({ 'topic': [topic, 'set', uid].join('/'), 'payload': String(b) }));

            return { 'ok': true, 'action': 'SET ' + a + ' = ' + b, 'mqtt': out, 'say': 'C\'est fait.', 'order': true };
        }

        // GET|kind|room (room empty: room of the voice device)
        const room = b || (satellite && satellite.cfg.room) || '';
        const id = a + '_' + room;
        const device = devices[id];
        if (!device || !Array.isArray(device.entities) || device.entities.length === 0) {
            return { 'ok': false, 'action': 'GET ' + id, 'say': 'Je n\'ai pas cette information.' };
        }
        const value = valueOf(device.entities[0]);
        const num = Number.parseFloat(value);
        const where = device.room || room;
        let say;
        switch (a) {
            case 'temperature':
                say = isNaN(num) ? null : 'Il fait ' + frNumber(num, 1) + ' degrés' + (where ? ' dans ' + where : '') + '.';
                break;
            case 'humidity':
                say = isNaN(num) ? null : 'L\'humidité est de ' + Math.round(num) + ' pour cent' + (where ? ' dans ' + where : '') + '.';
                break;
            case 'contact':
                say = value === undefined ? null : (BOOL_ON.includes(value) ? 'C\'est ouvert.' : 'C\'est fermé.');
                break;
            default:
                say = value === undefined ? null : String(value);
        }

        return { 'ok': say !== null, 'action': 'GET ' + id, 'say': say === null ? 'Je n\'ai pas encore de valeur.' : say };
    }

    // run a recognized sentence (from a voice device or from the dashboard)
    async function run(text, satellite) {
        const result = understand(text, satellite);
        if (result.mqtt) {
            for (const m of result.mqtt) {
                publish(m.topic, m.payload);
            }
        }

        return result;
    }

    engine.test = async function (text) {
        const result = await run(text, null);
        remember({ 'satellite': 'test', 'heard': String(text), 'action': result.action, 'say': result.say, 'ok': result.ok });

        return result;
    };

    // ---- voice session on a voice device

    function sendEvent(sat, type, data) {
        const list = [];
        for (const k in (data || {})) {
            list.push({ 'name': k, 'value': String(data[k]) });
        }
        try {
            sat.client.voiceAssistant.sendEvent(type, list);
        } catch (e) {
            log.warn('voice: ' + sat.id + ': event ' + type + ': ' + e.message);
        }
    }

    function startSession(sat, request) {
        if (sat.session) {
            endSession(sat, 'replaced');
        }
        const cfg = config();
        const session = {
            'id': crypto.randomBytes(4).toString('hex'),
            'started': Date.now(),
            'speech': 0,        // time of the first speech
            'lastLoud': 0,      // time of the last loud chunk
            'lastChunk': 0,     // time of the last new partial transcript
            'partial': '',
            'noise': [],        // levels of the first chunks: noise floor
            'threshold': 0,
            'stopping': false,
            'timer': null
        };
        sat.session = session;
        changed();

        try {
            sat.client.voiceAssistant.respondToRequest();
        } catch (e) {
            log.warn('voice: ' + sat.id + ': respond: ' + e.message);
        }
        sendEvent(sat, EVENT.RUN_START);
        sendEvent(sat, EVENT.STT_START);

        session.stt = wyoming.transcribe(cfg.vosk || 'dknr_voice_vosk:10300', {
            'language': 'fr',
            'onChunk': (chunk, all) => {
                if (all.trim() !== session.partial) {
                    session.partial = all.trim();
                    session.lastChunk = Date.now();
                    if (!session.speech) {
                        session.speech = Date.now();
                        sendEvent(sat, EVENT.STT_VAD_START);
                    }
                }
            }
        });
        session.stt.result.catch(() => { });
        session.timer = setInterval(() => checkEnd(sat, session), 100);
        log.debug('voice: ' + sat.id + ': session ' + session.id + ' (' + (request.wakeWordPhrase || 'button') + ')');
    }

    function audio(sat, chunk) {
        const session = sat.session;
        if (!session || session.stopping || !chunk || !chunk.data) {
            return;
        }
        session.stt.write(chunk.data);

        // noise floor from the first 300 ms, then loud chunks are speech
        const l = level(chunk.data);
        const now = Date.now();
        if (session.noise.length < 15 && now - session.started < 300) {
            session.noise.push(l);
            session.threshold = Math.max(300, 2.5 * session.noise.reduce((a, b) => a + b, 0) / session.noise.length);

            return;
        }
        if (l > session.threshold) {
            session.lastLoud = now;
            if (!session.speech) {
                session.speech = now;
                sendEvent(sat, EVENT.STT_VAD_START);
            }
        }
        if (chunk.end) {
            stopListening(sat, session);
        }
    }

    function checkEnd(sat, session) {
        if (sat.session !== session || session.stopping) {
            return;
        }
        const now = Date.now();
        const silent = session.speech && now - Math.max(session.lastLoud, session.speech) > SILENCE_END;
        const stable = session.partial !== '' && now - session.lastChunk > CHUNK_STABLE && now - session.lastLoud > 400;
        if ((session.speech && (silent || stable)) || now - session.started > LISTEN_MAX || (!session.speech && now - session.started > LISTEN_NOTHING)) {
            stopListening(sat, session);
        }
    }

    async function stopListening(sat, session) {
        if (session.stopping) {
            return;
        }
        session.stopping = true;
        clearInterval(session.timer);
        sendEvent(sat, EVENT.STT_VAD_END);

        let text = '';
        try {
            text = (await session.stt.end()).text;
        } catch (e) {
            log.warn('voice: ' + sat.id + ': speech to text: ' + e.message);
            sendEvent(sat, EVENT.ERROR, { 'code': 'stt-error', 'message': e.message });
            remember({ 'satellite': sat.cfg.name || sat.id, 'heard': '', 'action': '', 'say': 'erreur : ' + e.message, 'ok': false });
            endSession(sat, 'stt error');

            return;
        }
        if (sat.session !== session) {
            return;
        }
        if (text === '') {
            sendEvent(sat, EVENT.ERROR, { 'code': 'stt-no-text-recognized', 'message': 'Rien compris' });
            remember({ 'satellite': sat.cfg.name || sat.id, 'heard': '', 'action': '', 'say': '(rien reconnu)', 'ok': false });
            endSession(sat, 'nothing');

            return;
        }
        sendEvent(sat, EVENT.STT_END, { 'text': text });
        sendEvent(sat, EVENT.INTENT_START);

        const result = await run(text, sat);
        sendEvent(sat, EVENT.INTENT_END, { 'conversation_id': session.id });

        const cfg = config();
        let id = null;
        try {
            if (result.order && result.ok && cfg.response === 'sound') {
                id = keep(engine.sound);
            } else {
                sendEvent(sat, EVENT.TTS_START, { 'text': result.say });
                id = await speak(result.say);
            }
        } catch (e) {
            log.warn('voice: ' + sat.id + ': text to speech: ' + e.message);
        }
        if (sat.session !== session) {
            return;
        }
        if (id !== null) {
            sendEvent(sat, EVENT.TTS_END, { 'url': url(id) });
        }
        remember({ 'satellite': sat.cfg.name || sat.id, 'heard': text, 'action': result.action, 'say': result.say, 'ok': result.ok, 'ms': Date.now() - session.started });
        endSession(sat, 'done');
    }

    function endSession(sat, why) {
        const session = sat.session;
        if (!session) {
            return;
        }
        clearInterval(session.timer);
        if (!session.stopping) {
            session.stopping = true;
            session.stt.abort();
        }
        sat.session = null;
        if (why !== 'device') {
            sendEvent(sat, EVENT.RUN_END);
        }
        log.debug('voice: ' + sat.id + ': session ' + session.id + ' end (' + why + ')');
        changed();
    }

    // ---- connections to the voice devices

    function setState(sat, state, error) {
        if (sat.state !== state || (sat.error || '') !== (error || '')) {
            sat.state = state;
            sat.error = error || '';
            sat.since = Date.now();
            changed();
        }
    }

    async function connect(sat) {
        if (engine.closed || sat.stopped) {
            return;
        }
        setState(sat, 'connecting');
        try {
            if (!sat.client) {
                sat.client = await clientFactory({
                    'host': sat.cfg.host,
                    'port': Number(sat.cfg.port) || 6053,
                    'psk': sat.cfg.key || null,
                    'clientId': 'dknr-voice',
                    'logger': { 'debug': () => { }, 'info': () => { }, 'warn': (m) => log.debug('voice: ' + sat.id + ': ' + m), 'error': (m) => log.debug('voice: ' + sat.id + ': ' + m) }
                });
                sat.offs.push(sat.client.on('connect', () => setState(sat, 'online')));
                sat.offs.push(sat.client.on('disconnect', (reason) => {
                    if (sat.session) {
                        endSession(sat, 'device');
                    }
                    setState(sat, 'offline', reason ? String(reason) : '');
                }));
                sat.offs.push(sat.client.on('voiceAssistantRequest', (request) => {
                    if (request.start) {
                        startSession(sat, request);
                    } else if (sat.session) {
                        endSession(sat, 'device');
                    }
                }));
                sat.offs.push(sat.client.on('voiceAssistantAudio', (chunk) => audio(sat, chunk)));
            }
            await sat.client.connect({ 'signal': AbortSignal.timeout(15000) });
            if (!sat.subscribed) {
                // the client subscribes again by itself after a reconnection
                sat.client.voiceAssistant.subscribe(API_AUDIO);
                sat.subscribed = true;
            }
            setState(sat, 'online');
        } catch (e) {
            setState(sat, 'error', e && e.message ? e.message : String(e));
            // first connection failed: try again later (the client reconnects by itself once connected)
            clearTimeout(sat.retry);
            sat.retry = setTimeout(() => connect(sat), 30000);
        }
    }

    async function disconnect(sat) {
        sat.stopped = true;
        clearTimeout(sat.retry);
        if (sat.session) {
            endSession(sat, 'closing');
        }
        for (const off of sat.offs) {
            try {
                off && typeof off[Symbol.dispose] === 'function' ? off[Symbol.dispose]() : (typeof off === 'function' ? off() : null);
            } catch (e) { }
        }
        sat.offs = [];
        if (sat.client) {
            try {
                await sat.client.disconnectAsync();
            } catch (e) {
                try { sat.client.disconnect(); } catch (e2) { }
            }
        }
    }

    // connect to the configured voice devices, disconnect the removed or changed ones
    engine.start = async function () {
        const wanted = config().satellites || {};
        for (const id of Object.keys(engine.satellites)) {
            const sat = engine.satellites[id];
            const w = wanted[id];
            if (!w || w.host !== sat.cfg.host || String(w.port || '') !== String(sat.cfg.port || '') || w.key !== sat.cfg.key) {
                await disconnect(sat);
                delete engine.satellites[id];
            } else {
                sat.cfg = w;
            }
        }
        for (const id in wanted) {
            if (!engine.satellites[id] && wanted[id] && wanted[id].host) {
                const sat = { 'id': id, 'cfg': wanted[id], 'client': null, 'offs': [], 'session': null, 'state': 'offline', 'since': Date.now() };
                engine.satellites[id] = sat;
                connect(sat);
            }
        }
        changed();
    };

    engine.close = async function () {
        engine.closed = true;
        clearTimeout(statusTimer);
        for (const id of Object.keys(engine.satellites)) {
            await disconnect(engine.satellites[id]);
        }
        engine.satellites = {};
    };

    return engine;
}

module.exports = { create, level, chime, EVENT };
