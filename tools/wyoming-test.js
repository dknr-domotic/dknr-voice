#!/usr/bin/env node
'use strict';

// Test the Wyoming services of dknr-voice without a voice device.
//
//   node tools/wyoming-test.js info <host:port>
//   node tools/wyoming-test.js stt  <file.wav> [host:port]          (wyoming-vosk, default 127.0.0.1:10300)
//   node tools/wyoming-test.js tts  "<texte>" <out.wav> [host:port] [voice]   (wyoming-piper, default 127.0.0.1:10200)
//
// The WAV file for stt must be PCM 16 bits mono, 16 kHz (record it with:
//   arecord -f S16_LE -r 16000 -c 1 -d 4 phrase.wav
// or convert it with: ffmpeg -i in.m4a -ar 16000 -ac 1 -sample_fmt s16 phrase.wav)

const fs = require('fs');
const path = require('path');
const wyoming = require(path.join(__dirname, '..', 'lib', 'wyoming.js'));

async function main() {
    const [cmd, a, b, c, d] = process.argv.slice(2);

    if (cmd === 'info' && a) {
        console.log(JSON.stringify(await wyoming.describe(a, 10300), null, 2));

        return;
    }

    if (cmd === 'stt' && a) {
        const audio = wyoming.readWav(fs.readFileSync(a));
        if (audio.rate !== 16000 || audio.width !== 2 || audio.channels !== 1) {
            console.warn(`attention : ${audio.rate} Hz, ${audio.width * 8} bits, ${audio.channels} canal(aux) ; attendu 16000 Hz, 16 bits, mono`);
        }
        const started = Date.now();
        const stt = wyoming.transcribe(b || '127.0.0.1:10300', {
            'language': 'fr',
            'rate': audio.rate,
            'width': audio.width,
            'channels': audio.channels,
            'onChunk': (text, all) => console.log('  partiel :', all)
        });
        // send by chunks of 20 ms, like a voice device
        const step = Math.round(audio.rate * 0.02) * audio.width * audio.channels;
        for (let i = 0; i < audio.pcm.length; i += step) {
            stt.write(audio.pcm.subarray(i, i + step));
        }
        const sent = Date.now();
        const result = await stt.end();
        console.log('transcription :', JSON.stringify(result.text));
        console.log(`délai après la fin du son : ${Date.now() - sent} ms (total ${Date.now() - started} ms)`);

        return;
    }

    if (cmd === 'tts' && a && b) {
        const started = Date.now();
        const audio = await wyoming.synthesize(c || '127.0.0.1:10200', a, { 'voice': d });
        fs.writeFileSync(b, wyoming.wav(audio.pcm, audio.rate, audio.width, audio.channels));
        const seconds = audio.pcm.length / (audio.rate * audio.width * audio.channels);
        console.log(`${b} : ${seconds.toFixed(1)} s de son, ${audio.rate} Hz, synthèse en ${Date.now() - started} ms`);

        return;
    }

    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 13).join('\n'));
    process.exitCode = 1;
}

main().catch((err) => {
    console.error('erreur :', err.message);
    process.exitCode = 1;
});
