# Conception de dknr-voice

Document de conception rédigé avant le développement (novembre 2026). Il réunit le contexte, les éléments déjà vérifiés et les choix à faire. La section *Etat d'avancement* suit ce qui a été décidé et construit depuis.


## Objectif

Piloter les entités DKNR (toutes sources confondues, lues sur MQTT) **à la voix, 100 % en local** : aucun serveur tiers, aucune connexion vers internet, aucun Home Assistant. Le son est capté par des boîtiers ESP32 dans les pièces, reconnu et interprété sur la machine Docker de la maison, et les ordres sont publiés sur `dknr/set`.

dknr-voice ne remplace pas dknr-alexa ou dknr-matter : les Echo peuvent rester en place à côté.


## Contexte vérifié (novembre 2026)

### Chaîne d'une commande vocale

Mot d'activation → captation de la phrase → reconnaissance (voix vers texte) → compréhension de l'ordre → publication MQTT → réponse (voix ou son).

### Les boîtiers (satellites)

* **Home Assistant Voice Preview Edition** (Nabu Casa, environ 59 €) : ESP32-S3, processeur audio XMOS (annulation d'écho, réduction de bruit), deux micros, haut-parleur, prise jack, anneau de LED, bouton, molette de volume. Matériel et firmware open source ([esphome/home-assistant-voice-pe](https://github.com/esphome/home-assistant-voice-pe)).
* **Firmware ESPHome** : le boîtier ne parle **pas** Wyoming. Il dialogue avec son serveur par l'**API native ESPHome** (TCP 6053, chiffrée par le protocole Noise). Home Assistant n'est qu'un client de cette API : un autre client peut prendre sa place.
* **Mot d'activation sur le boîtier** (micro_wake_word) : modèles fournis `okay_nabu`, `hey_jarvis`, `hey_mycroft` (et `stop` pour couper une réponse). Des modèles personnalisés peuvent être ajoutés dans la configuration ESPHome (voir *Evolutions*). openWakeWord (côté serveur) n'est pas utilisé par ce boîtier.
* **Chiffrement** : la configuration officielle laisse la clé de l'API vide (`encryption:  # Uses key set by Home Assistant`). Sans Home Assistant, le boîtier doit être **reflashé avec notre propre configuration**, qui reprend la configuration officielle comme *package* ESPHome et fixe la clé.
* **Lecture des réponses** : le boîtier lit un fichier audio dont le serveur lui donne l'URL (lecteur ESPHome *media_player*, FLAC 48 kHz dans la configuration officielle). Le serveur doit donc servir les réponses en HTTP sur le réseau local.
* **Autres boîtiers compatibles** : tout appareil ESPHome avec le composant `voice_assistant` (ESP32-S3-BOX-3, M5Stack Atom Echo, FutureProofHomes Satellite1...) parle la même API. Les micros et l'audio sont moins bons que ceux du Voice PE pour les modèles les moins chers.
* **Raspberry Pi + ReSpeaker** (wyoming-satellite) : écarté, l'expérience passée montrait une mauvaise captation.

### Le client de l'API ESPHome

* **[esphome-client](https://github.com/hjdhjd/esphome-client)** (npm, licence ISC, version 2.1.0 du 6 novembre 2026, projet actif) : client Node.js de l'API native ESPHome, sans dépendance externe, chiffrement Noise compris. Il gère l'assistant vocal : abonnement (`subscribeVoiceAssistant`, flux audio par l'API), demande de session venue du boîtier (`voiceAssistantRequest`, avec le mot d'activation), réception du son (`voiceAssistantAudio`), envoi des événements de session (`RUN_START`, `STT_START`, `STT_END`, `INTENT_END`, `TTS_END`, `ERROR`...), configuration des mots d'activation, annonces.
* **Pré-requis** : ESPHome 2025.10 ou plus récent, **Node.js 22.20 ou plus récent** (à vérifier sur l'image `nodered/node-red` utilisée).

### La reconnaissance vocale

* **Speech-to-Phrase** (OHF-Voice) : écarté. Rapide et en français, mais il **exige Home Assistant** (`--hass-token` obligatoire, il lit les entités et les pièces par le websocket de HA). La nouvelle version (dépôt OHF-Voice/apps) est aussi conçue pour Home Assistant.
* **[wyoming-vosk](https://github.com/rhasspy/wyoming-vosk)** (rhasspy, mis à jour en septembre 2026) : serveur Wyoming autour de Vosk (Kaldi), **sans Home Assistant**. Il tourne même sur un Raspberry Pi 3. Modèle français `vosk-model-small-fr-0.22`, téléchargé automatiquement. Trois modes :
    * *ouvert* : n'importe quelle phrase, reconnaissance médiocre ;
    * *corrigé* (`--correct-sentences`) : une phrase proche d'un modèle de phrase est ramenée à ce modèle ;
    * *limité* (`--limit-sentences`) : **seules les phrases des modèles** peuvent être reconnues, la meilleure précision possible.
* **Modèles de phrases** : un fichier YAML par langue (`<dossier>/fr.yaml`), syntaxe [hassil](https://github.com/home-assistant/hassil) : mots facultatifs `[ ]`, alternatives `( | )`, listes `{liste}`, règles `<règle>`, plages de nombres (`range`, écrites en toutes lettres en français), et surtout la forme **`in` / `out`** : on dit `in`, la transcription renvoyée est `out`. Le fichier est **relu automatiquement** quand il change (date ou taille), sans redémarrer le conteneur.
* **Flux** : les transcriptions partielles sont envoyées pendant que l'on parle (`transcript-chunk`), la transcription corrigée à la fin.
* **faster-whisper** (Wyoming) : phrases libres, mais trop lourd pour le matériel disponible et il faudrait une compréhension séparée. Écarté, comme les LLM locaux.

### La synthèse vocale

* **[wyoming-piper](https://github.com/rhasspy/wyoming-piper)** : synthèse locale, rapide sur un processeur ordinaire, plusieurs voix françaises (`fr_FR-siwis-medium`, `fr_FR-upmc-medium`, `fr_FR-tom-medium`... à écouter pour choisir).

### Rhasspy

Rhasspy 2.5 (protocole Hermes sur MQTT) fonctionnait bien mais n'est plus maintenu. dknr-voice en reprend l'idée : des phrases connues à l'avance, générées depuis la domotique.


## Etat d'avancement

* **Matériel** : boîtiers ESP32 retenus (novembre 2026), Voice PE retenu. Un boîtier commandé pour le prototype (en attente de stock, novembre 2026).
* **Dépôt** : `dknr-domotic/dknr-voice` créé, ce document est le premier contenu.
* Rien n'est encore développé.


## Choix à faire

### 1. La reconnaissance

| Option | Principe | Pour | Contre |
| --- | --- | --- | --- |
| **A. wyoming-vosk, mode limité** | Les phrases possibles sont générées depuis la configuration de dknr-voice. Chaque phrase porte dans son `out` l'action à faire. | Aucune dépendance à Home Assistant. Très léger. Reconnaissance et compréhension faites en une fois. Précis. | Une phrase hors des modèles est ramenée de force au modèle le plus proche : il faut un seuil et une phrase de confirmation pour éviter les faux ordres. |
| **B. wyoming-vosk, mode corrigé** | Comme A, mais une phrase trop éloignée des modèles reste telle quelle (et n'est pas comprise). | Moins de faux ordres. | Moins précis que A sur les phrases connues. |
| **C. Speech-to-Phrase** | Reconnaissance limitée aux phrases de Home Assistant. | Très bonne qualité en français. | Exige Home Assistant. Hors sujet. |

Recommandation : **A**, en gardant B sous la main (une seule option à changer) si des faux ordres apparaissent. À vérifier avec `--allow-unknown`, que le modèle français accepte d'après la documentation : il permet de rejeter une phrase hors domaine même en mode limité.

### 2. Ce que l'on peut dire

* **Option recommandée** : une page **Appareils** propre à dknr-voice, sur le modèle de celle de dknr-matter : **nom prononcé** (avec des variantes, ex : « plafonnier », « lumière du salon »), **pièce**, **type**, une ou plusieurs **entités DKNR**, actif. Seuls ces appareils sont dans les phrases : moins il y a de phrases, meilleure est la reconnaissance.
* Alternative : générer les phrases automatiquement depuis toutes les entités de la discovery DKNR. Plus rapide à mettre en place, mais les noms techniques se prononcent mal et le nombre de phrases explose.

### 3. Les phrases

Première version, par type :

| Type | Exemples | Action (`out`) |
| --- | --- | --- |
| lumière, prise | « allume / éteins [la lumière du] {appareil} » | `1` / `0` |
| variateur | « allume / éteins {appareil} », « mets {appareil} à {n} [pour cent] » | `99` / `0` / `n` |
| volet | « ouvre / ferme {appareil} », « mets {appareil} à {n} [pour cent] » | `99` / `0` / `n` |
| température, humidité | « quelle est la température [du / de la] {pièce} » | lecture de la dernière valeur, réponse parlée |
| ouverture | « est-ce que {appareil} est ouvert » | lecture, réponse parlée |

* **Pièce implicite** : chaque boîtier a une pièce. « Allume la lumière » sans pièce vise l'appareil de ce type dans la pièce du boîtier.
* **Pièce entière** : « éteins tout dans {pièce} », plus tard.
* **Format du `out`** : une chaîne simple que dknr-voice décode, ex : `SET|<appareil>|<valeur>` ou `GET|<appareil>`. Les identifiants d'appareils ne sont jamais prononcés, seulement placés dans `out`.
* **Nombres** : plage `range` (0 à 100, pas de 5 ou de 10) écrite en toutes lettres par wyoming-vosk.

### 4. La réponse

* **Phrase parlée** (Piper) : « c'est fait », « il fait vingt et un degrés et demi dans le salon ». Indispensable pour les questions.
* **Son court** pour les ordres simples : plus rapide, moins bavard.
* Recommandation : son court pour les ordres, phrase parlée pour les questions et les erreurs (« je n'ai pas compris »), réglable dans la page **Configurer**.

### 5. Où vit l'orchestration

* **Option recommandée** : dans Node-RED, comme matter.js dans dknr-matter. `esphome-client` est chargé dans des nœuds function (`functionExternalModules`). Une connexion par boîtier, créée au démarrage et fermée proprement à chaque déploiement.
* Alternative : un petit service Node.js séparé qui parle MQTT avec Node-RED. Plus simple à déboguer, mais sort de la structure dknr.

### 6. La fin de phrase

Le boîtier envoie le son tant que le serveur ne lui dit pas d'arrêter : c'est au serveur de détecter la fin de la phrase (rôle tenu par Home Assistant d'habitude).

* **Option recommandée** : s'appuyer sur les transcriptions partielles de wyoming-vosk. Quand elles n'évoluent plus pendant environ 0,8 s, ou quand le niveau sonore reste bas, on arrête l'écoute. Durée maximale de 8 s.
* Alternative : un détecteur d'activité vocale dédié (Silero VAD en ONNX). Plus fiable, mais plus lourd. Seulement si l'option simple ne suffit pas.


## Fonctionnement prévu

### Architecture

```
 Boîtier ESP32 (pièce)                  Machine Docker
 ┌───────────────────┐  API ESPHome    ┌──────────────────────────────┐   Wyoming   ┌──────────────┐
 │ mot d'activation  │ ◄─────────────► │ dknr-voice (Node-RED)        │ ◄─────────► │ wyoming-vosk │
 │ micros + XMOS     │   TCP 6053      │  - sessions vocales          │  TCP 10300  └──────────────┘
 │ haut-parleur      │                 │  - génération de fr.yaml ────┼──► volume partagé (phrases)
 │ LED, bouton       │ ─── HTTP ─────► │  - réponses audio (HTTP)     │   Wyoming   ┌──────────────┐
 └───────────────────┘  lecture        │  - MQTT dknr/get, dknr/set   │ ◄─────────► │ wyoming-piper│
                                       └──────────────────────────────┘  TCP 10200  └──────────────┘
```

### Une session

1. Le boîtier entend le mot d'activation et demande une session (`voiceAssistantRequest`).
2. dknr-voice accepte (son par l'API), envoie `RUN_START` puis `STT_START` (l'anneau de LED passe en écoute) et ouvre une transcription chez wyoming-vosk.
3. Les morceaux de son sont transmis à wyoming-vosk au fil de l'eau. À la fin de la phrase (voir *choix 6*), dknr-voice ferme le flux, envoie `STT_END` avec le texte reconnu.
4. Le `out` de la phrase reconnue est décodé : ordre publié sur `dknr/set/<source>/<parent>/<entité>` pour chaque entité de l'appareil, ou valeur lue pour une question. `INTENT_END`.
5. La réponse (son court ou phrase Piper) est préparée et servie en HTTP. `TTS_END` porte son URL, le boîtier la lit. `RUN_END`.
6. En cas d'échec (rien reconnu, appareil inconnu), `ERROR` puis réponse « je n'ai pas compris ».

### Entités DKNR

Comme dknr-alexa et dknr-matter :

* Catalogue depuis `dknr/discovery/<source>/<parent>/<entité>` (nom, groupe, type, unité, options), valeurs depuis `dknr/get/<source>/<parent>/<entité>`.
* Commandes sur `dknr/set/<source>/<parent>/<entité>`.
* Format DKNR : binaires `1` / `0`, listes par clé d'option, `rb` = binaire inversé.
* Dernière valeur conservée dans le contexte persistant pour les sources qui ne publient pas en `retain` (RFXCom, Daikin), pour répondre aux questions.

### Génération des phrases

* À chaque enregistrement d'un appareil ou d'un boîtier, dknr-voice réécrit `fr.yaml` dans le volume partagé avec wyoming-vosk, qui le relit tout seul.
* Les noms des appareils et des pièces vont dans des listes (`in` = nom prononcé, `out` = identifiant), les familles de phrases dans des règles. Les pièces implicites sont décodées par dknr-voice à partir du boîtier qui a parlé.
* La page **Phrases** affiche les phrases générées et permet de tester une phrase écrite sans parler.

### Pages

* **Appareils** : liste, ajout, modification (nom prononcé et variantes, pièce, type, entités, actif).
* **Boîtiers** : nom, pièce, adresse IP, clé de l'API (stockée dans les *credentials* Node-RED), mot d'activation, état de la connexion, dernière phrase entendue, bouton de test (fait parler le boîtier).
* **Phrases** : phrases générées, test écrit.
* **Configurer** : MQTT (hôte, port, utilisateur, mot de passe, topic `dknr`), adresses de wyoming-vosk et wyoming-piper, voix Piper, type de réponse (son ou voix), adresse HTTP par laquelle les boîtiers joignent dknr-voice, sauvegarde et restauration.


## Configuration des boîtiers

Un dossier `esphome/` du dépôt fournit une configuration à compiler avec ESPHome (conteneur `esphome/esphome` ou outil en ligne de commande) :

```yaml
substitutions:
  name: dknr-voice-salon
  friendly_name: DKNR Voice Salon

packages:
  voice_pe: github://esphome/home-assistant-voice-pe/home-assistant-voice.yaml@<version>

esphome:
  name: ${name}
  name_add_mac_suffix: false
  friendly_name: ${friendly_name}

api:
  encryption:
    key: !secret dknr_voice_api_key

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password
```

* Version du *package* **figée** (étiquette ou commit) : une mise à jour d'ESPHome ou du firmware ne doit pas casser le dialogue avec dknr-voice sans que l'on s'en rende compte.
* Premier flash par USB (bouton maintenu au branchement), puis mises à jour par le réseau (OTA).
* Adresse IP fixe (réservation DHCP) conseillée, renseignée dans la page **Boîtiers**.


## Structure attendue du dépôt

Comme les autres dépôts dknr (voir dknr-matter) :

* `Dockerfile` (image `nodered/node-red` avec Node.js 22.20 ou plus, clone du dépôt dans `/data/projects/dknr-voice`), `docker-entrypoint.sh`, `data/settings.js` (`httpAdminRoot: "/admin"`, projets activés, `functionExternalModules: true`).
* `docker-compose.yaml` avec trois services : `dknr_voice`, `wyoming_vosk` (`--language fr --sentences-dir /sentences --correct-sentences --limit-sentences`) et `wyoming_piper` (voix française), et un volume partagé pour les phrases. Pas besoin de `network_mode: host` : dknr-voice joint les boîtiers par leur IP, les boîtiers joignent dknr-voice par le port publié (le port 80 de l'hôte est déjà pris, `PORT` à 1880 par exemple).
* `package.json` avec `@flowfuse/node-red-dashboard` et `esphome-client`, `flows.json`.
* `esphome/` : configuration des boîtiers et exemple de `secrets.yaml` (jamais les vrais secrets dans le dépôt).
* `.github/workflows` : `release.yaml`, `release_dev.yaml`, `clean_repository.yml`, `update_docker_readme.yml`, `dependabot.yml`. Secrets `DOCKER_USERNAME` / `DOCKER_TOKEN` à créer sur le dépôt.
* `README.md` dans le style des autres projets, et une page sur le site [dknr-domotic.github.io](https://dknr-domotic.github.io) (section Intégrations).


## Prototype (version 0.1)

But : valider toute la chaîne avec un seul boîtier, avant de construire les pages.

1. Flasher un Voice PE avec la configuration de `esphome/`.
2. Lancer wyoming-vosk et wyoming-piper avec un `fr.yaml` écrit à la main (deux phrases : allumer et éteindre une prise de test).
3. Dans Node-RED : connexion au boîtier avec `esphome-client`, session vocale complète, ordre publié sur `dknr/set`, réponse Piper lue par le boîtier.
4. Mesurer : délai entre la fin de la phrase et l'ordre MQTT, délai jusqu'à la réponse, taux de reconnaissance dans une pièce bruyante (télé allumée), faux déclenchements du mot d'activation.
5. Vérifier : format audio accepté par le boîtier pour les réponses (WAV de Piper directement, ou conversion en FLAC 48 kHz comme Home Assistant), reconnexion après un redémarrage du boîtier et un redéploiement Node-RED.


## Tests

* **Sans boîtier** : un client Wyoming en ligne de commande envoie un fichier WAV enregistré à wyoming-vosk pour régler les phrases et le seuil. La page **Phrases** teste le décodage des `out` sans parler.
* **Avec un boîtier** : le prototype ci-dessus, puis plusieurs voix (adulte, enfant), plusieurs distances, bruit de fond.
* **Robustesse** : redéploiement Node-RED, redémarrage des conteneurs et des boîtiers, coupure Wi-Fi, ajout d'un appareil pendant que wyoming-vosk tourne (relecture de `fr.yaml`).


## Evolutions

* **Annonces** : publier un texte sur un topic (ex : `dknr/set/voice/<boîtier>/announce`) pour faire parler un boîtier (sonnette, alarme Verisure, fin de cycle de lave-linge...). L'API ESPHome le permet (`VOICE_ASSISTANT_ANNOUNCE_REQUEST`).
* **Boîtiers comme source DKNR** : publier chaque boîtier dans la discovery DKNR (micro coupé, volume, dernière phrase, bouton), pour l'utiliser dans dknr-domotic comme les autres sources.
* **Scènes de dknr-domotic** à la voix (« active le mode cinéma »), une fois les scènes créées.
* **Mot d'activation personnalisé** en français, entraîné avec microWakeWord et ajouté à la configuration ESPHome des boîtiers.
* **Minuteurs** (« mets un minuteur de dix minutes ») : le Voice PE les affiche sur son anneau de LED, l'API ESPHome les gère.
* Thermostat (consigne) et serrure, avec une confirmation orale avant tout déverrouillage.
