# README

[![Release](https://img.shields.io/docker/v/jcpd/dknr-voice?sort=semver)](https://img.shields.io/docker/v/jcpd/dknr-voice?sort=semver)
[![Pull](https://img.shields.io/docker/pulls/jcpd/dknr-voice)](https://img.shields.io/docker/pulls/jcpd/dknr-voice)
[![Issue](https://img.shields.io/github/issues/dknr-domotic/dknr-voice)](https://img.shields.io/github/issues/dknr-domotic/dknr-voice)
[![License](https://img.shields.io/github/license/dknr-domotic/dknr-voice)](https://github.com/dknr-domotic/dknr-voice/blob/main/LICENSE)


## A propos

**dknr-voice** pilote à la voix les entités des autres projets DKNR (Zigbee, Z-Wave, RFXCom, Daikin...), **100 % en local** : aucun serveur tiers, aucune connexion vers internet, aucun Home Assistant. Le son est capté par des boîtiers ESP32 sous ESPHome dans les pièces, reconnu par [Vosk](https://alphacephei.com/vosk) parmi des phrases connues à l'avance, et les ordres sont publiés sur le serveur MQTT DKNR. Les réponses sont dites par [Piper](https://github.com/rhasspy/piper).

> **Prototype (version 0.1)** : un seul boîtier, configuré par des variables d'environnement, et des phrases écrites à la main (`sentences/fr.yaml`). Les pages de configuration viendront ensuite. Voir [docs/CONCEPTION.md](docs/CONCEPTION.md).

## Fonctionnalités

- **Commande vocale locale** : mot d'activation reconnu par le boîtier, phrase reconnue sur le serveur, ordre publié sur `dknr/set`.
- **Phrases connues à l'avance** : seules les phrases des modèles sont reconnues, les autres sont rejetées.
- **Questions** : « quelle est la température du salon », réponse dite par le boîtier.
- **Réponse** parlée, ou son court pour les ordres.
- **Page Boîtiers** : état de la connexion, dernières phrases entendues, test d'une phrase sans parler.


## Matériel requis

* un serveur MQTT, partagé avec les autres projets DKNR.
* au moins un projet DKNR publiant des entités (ex : [DKNR Zigbee](https://github.com/dknr-domotic/dknr-zigbee)).
* un boîtier **Home Assistant Voice Preview Edition** (Nabu Casa) par pièce, alimenté en USB-C (5 V, 2 A), et un câble USB-C de données pour le premier flash.
* une machine exécutant le logiciel docker, sur le même réseau local que les boîtiers.


## Installation

### Conteneurs

Des images Docker prêtes à l'emploi sont disponibles. Le fichier `docker-compose.yaml` à la racine du dépôt lance trois conteneurs :

* **dknr_voice** : Node-RED, dialogue avec les boîtiers (API ESPHome, TCP 6053) et le serveur MQTT, sert les réponses aux boîtiers (HTTP, port 1880).
* **dknr_voice_vosk** : reconnaissance vocale (Wyoming, TCP 10300), image `jcpd/dknr-voice-vosk` construite depuis `docker/vosk` (wyoming-vosk 1.6.0, pas encore publié par rhasspy).
* **dknr_voice_piper** : synthèse vocale (Wyoming, TCP 10200), image `rhasspy/wyoming-piper`, voix française.

Variables d'environnement de **dknr_voice** :

* **DKNR_USERNAME** : login de l'interface node-red.
* **DKNR_PASSWORD** : mot de passe de l'interface node-red.
* **DKNR_SECRET**   : un mot secret pour encrypter les credits.
* **DKNR_VOICE_URL** : adresse de dknr_voice vue par les boîtiers, pour lire les réponses (ex : `http://10.40.0.127:1880`).
* **DKNR_VOICE_HOST** : adresse IP du boîtier.
* **DKNR_VOICE_KEY** : clé de chiffrement de l'API ESPHome du boîtier (la même que dans `esphome/secrets.yaml`).
* **DKNR_VOICE_ROOM** : pièce du boîtier (`salon` par défaut), **DKNR_VOICE_NAME** : son nom.
* **DKNR_VOICE_DEVICES** : appareils utilisés dans les phrases et leurs entités DKNR, en JSON (voir *Phrases*).
* **DKNR_VOICE_RESPONSE** : `voice` (réponse parlée, par défaut) ou `sound` (son court pour les ordres).
* **PORT** : port HTTP du tableau de bord, de l'éditeur Node-RED et des réponses (`1880` par défaut).

Les modèles de Vosk (environ 40 Mo) et la voix de Piper sont téléchargés au premier démarrage, dans les volumes des conteneurs.

Le tableau de bord DKNR est disponible sur `http://<ip du serveur docker>:1880/` et l'éditeur Node-RED sur `http://<ip du serveur docker>:1880/admin`.

### Boîtier

Le boîtier est flashé avec la configuration du dossier `esphome/`, qui reprend la configuration officielle du Voice PE (version figée) et y ajoute le Wi-Fi et la clé de l'API ESPHome :

1. Copiez `esphome/secrets.yaml.example` en `esphome/secrets.yaml`, renseignez le Wi-Fi et une clé générée avec `openssl rand -base64 32`.
2. Branchez le boîtier en USB sur la machine docker, puis dans le dossier `esphome/` :
   ```sh
   docker run --rm -it -v "${PWD}":/config --device=/dev/ttyACM0 esphome/esphome:2026.10 run dknr-voice.yaml
   ```
3. Les mises à jour suivantes passent par le Wi-Fi (même commande, sans `--device`).

Réservez une adresse IP fixe au boîtier dans votre box ou votre serveur DHCP.


## Configuration

### MQTT

Dans la page **Configurer** : **adresse IP**, **port**, **utilisateur** et **mot de passe** du serveur MQTT, le même que celui des autres projets DKNR, et **topic** racine des topics DKNR (`dknr` par défaut).

### Phrases

Les phrases sont dans `sentences/fr.yaml` (copié dans le volume partagé avec Vosk au premier démarrage, relu par Vosk à chaque modification). Chaque phrase donne un résultat (`out`) :

* `SET|<appareil>|<valeur>` : la valeur est publiée sur `dknr/set/<entité>` pour chaque entité de l'appareil.
* `GET|<mesure>|<pièce>` : question, la réponse vient de l'appareil `<mesure>_<pièce>` (ex : `temperature_salon`).

Les appareils et leurs entités DKNR sont donnés par **DKNR_VOICE_DEVICES** :

```json
{
  "test": { "entities": ["zwave/12/switch"] },
  "temperature_salon": { "room": "le salon", "entities": ["zigbee/0x1234/temperature"] }
}
```

La page **Boîtiers** permet de tester un résultat sans parler (ex : `SET|test|1`).


## Tester sans boîtier

Le script `tools/wyoming-test.js` interroge Vosk et Piper depuis le conteneur dknr_voice :

```sh
# reconnaissance d'un fichier WAV (16 kHz, 16 bits, mono), à copier d'abord dans le volume
docker exec dknr_voice node /data/projects/dknr-voice/tools/wyoming-test.js stt /data/phrase.wav dknr_voice_vosk:10300
# synthèse d'une phrase
docker exec dknr_voice node /data/projects/dknr-voice/tools/wyoming-test.js tts "Il fait vingt et un degrés." /data/test.wav dknr_voice_piper:10200
```

Pour enregistrer une phrase : `arecord -f S16_LE -r 16000 -c 1 -d 4 phrase.wav`, ou convertir un enregistrement de téléphone : `ffmpeg -i phrase.m4a -ar 16000 -ac 1 -sample_fmt s16 phrase.wav`.


## Fonctionnement

1. Le boîtier entend le mot d'activation (« Okay Nabu », « Hey Jarvis » ou « Hey Mycroft ») et ouvre une session.
2. dknr_voice transmet le son à Vosk au fil de l'eau et détecte la fin de la phrase (silence de 0,7 s, ou plus de nouveau mot reconnu, 8 s au plus).
3. Le résultat de la phrase reconnue est exécuté : ordre MQTT, ou lecture de la dernière valeur d'une entité.
4. La réponse est préparée par Piper (ou un son court) et servie en HTTP, le boîtier la lit.

Le moteur est dans `lib/voice.js` (sessions, fin de phrase, ordres) et `lib/wyoming.js` (protocole Wyoming), chargés par `data/settings.js` et utilisés par le nœud `voice` de l'onglet `custom`.


## A faire

* Pages **Boîtiers** (plusieurs boîtiers) et **Appareils** (noms prononcés, pièces, entités), génération automatique des phrases.
* Annonces (faire parler un boîtier depuis MQTT), boîtiers comme source DKNR.
* Mot d'activation en français.


## Contribuer

Ce projet est **open-source**, vous pouvez participer en créant des [tickets](https://github.com/dknr-domotic/dknr-voice/issues) ou en proposant de [requêtes](https://github.com/dknr-domotic/dknr-voice/pulls) sur le dépôt github du projet.


## Voir aussi

- [DKNR Domotic](https://github.com/dknr-domotic/dknr-domotic)
- [DKNR Matter](https://github.com/dknr-domotic/dknr-matter)
- [wyoming-vosk](https://github.com/rhasspy/wyoming-vosk), [wyoming-piper](https://github.com/rhasspy/wyoming-piper), [esphome-client](https://github.com/hjdhjd/esphome-client)
- [Home Assistant Voice Preview Edition](https://github.com/esphome/home-assistant-voice-pe)
- Documentation des projets DKNR : https://dknr-domotic.github.io
