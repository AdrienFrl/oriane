# CLAUDE.md — ORIANE

Guide de travail pour Claude Code sur ce dépôt. Langue du projet : **français** (code commenté, interface, messages de commit, documentation).

## Le projet

ORIANE : guidage piéton vocal + détection d'obstacles par caméra + sons spatialisés, pour personnes aveugles et malvoyantes. Projet scolaire d'Adrien Feriolo. Complète la canne ou le chien guide, ne les remplace pas.

- Dépôt : <https://github.com/AdrienFrl/oriane> (public, branche `main`)
- En ligne : <https://adrienfrl.github.io/oriane/> (GitHub Pages, déployé depuis `main`, racine)
- Téléphone de test : OnePlus Nord 2T, Chrome Android
- Version en ligne : **v2.1**. En développement : **v2.2 anti-surcharge**, lot 2.2-0 fait (`VERSION` = `2.2-0` dans `js/app.js`, voir `source/HANDOFF.md`)

## Règles impératives

1. **Tout doit rester gratuit** : aucun service payant, aucune clé obligatoire, aucune carte bancaire.
2. **Les images de la caméra ne quittent jamais le téléphone.** Aucun envoi d'image à un serveur.
3. **Aucune clé ni secret dans le dépôt.** La clé OpenRouteService facultative est saisie par l'utilisateur et stockée dans `localStorage` seulement.
4. **La spécification de connexion aux lunettes Star Glasses / Blacksheep AG18 est confidentielle** : elle vit uniquement dans les documents du Projet Claude « ORIANE » (`specs/SPEC_CONNEXION_LUNETTES_STAR_GLASSES.md`). Ne jamais la copier dans ce dépôt public, ne copier aucun code de l'application d'origine, ne réutiliser aucune clé ni aucun serveur de l'éditeur.
5. Pas de compilation : site statique en modules ES. Ne pas introduire de bundler sans accord.
6. Toute règle d'alerte est écrite en **module pur** testable sous Node (pour être portée en Kotlin plus tard).
7. Ne pas commiter ni pousser sans que l'utilisateur le demande.

## Technologies

| Domaine | Techno | Détail |
|---|---|---|
| Application | HTML + CSS + JavaScript (modules ES), PWA | `index.html`, `css/style.css`, `js/*.js`, `manifest.webmanifest`, `icon.svg` |
| Segmentation | SegFormer-B0 ADE20K via **Transformers.js 3** | Modèle `Xenova/segformer-b0-finetuned-ade-512-512` (fp32 15,3 Mo / fp16 7,9 Mo / q8 4,4 Mo). WebGPU + fp32, sinon WASM + q8. Dans un Web Worker module. Licence du modèle non commerciale |
| Détection de secours | **TensorFlow.js 4.22.0** + **COCO-SSD 2.2.3** | `js/vision.js` |
| Profondeur (expérimental, non branché) | Depth Anything V2 Small | `onnx-community/depth-anything-v2-small`, `js/depth.js` |
| Distance | Géométrie au sol | `d = h / tan(inclinaison + atan((y − cy)/f))`, inclinaison = 90 − beta de `deviceorientation` |
| Son | Web Audio API, `PannerNode` HRTF | `js/audio.js` |
| Voix | Web Speech API : `speechSynthesis` (file à priorités) et `webkitSpeechRecognition` (continu pour « Dis Oriane ») | `js/speech.js`, `js/wake.js` |
| Capteurs | `deviceorientation`, `devicemotion`, Vibration API, Wake Lock API, Geolocation | `js/app.js` |
| Géocodage | Photon (Komoot), secours Nominatim | `js/geo.js`, `js/places.js` |
| Itinéraire piéton | OSRM « foot » de FOSSGIS (`routing.openstreetmap.de`), ou OpenRouteService si clé | `js/geo.js` |
| Repères et lieux | Overpass API (passages piétons, feux, commerces, catégories) | `js/geo.js`, `js/places.js` |
| Tests | `node --test` (Node 20+), Playwright + Chromium pour l'e2e | `tests/*.test.js`, `tests/e2e/rejeu.e2e.mjs` |

### Dépendances (toutes chargées par CDN, aucune installation pour l'appli)

- `https://cdn.jsdelivr.net/npm/@huggingface/transformers@3`
- `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js`
- `https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js`
- Modèles téléchargés depuis Hugging Face au premier lancement puis mis en cache par le navigateur.

### Services web gratuits appelés

- `https://photon.komoot.io/api/` et `/reverse`
- `https://nominatim.openstreetmap.org/search`
- `https://routing.openstreetmap.de/routed-foot/route/v1/foot/`
- `https://api.openrouteservice.org/v2/directions/foot-walking/geojson` (facultatif, clé utilisateur)
- `https://overpass-api.de/api/interpreter`
- Données © contributeurs OpenStreetMap (attribution affichée).

### Développement

- `package.json` : `"type": "module"`, script `test` = `node --test tests/*.test.js`. Aucune dépendance npm pour l'appli.
- Tests e2e : `npm run e2e` (`tests/e2e/rejeu.e2e.mjs`). Playwright et Chromium préinstallés dans l'environnement cloud (sinon `PLAYWRIGHT_CHROMIUM=/chemin/chrome`). Le script lance `python3 -m http.server 8765`, une fausse caméra Chromium et un faux module transformers ; tout autre accès réseau est bloqué. Il enregistre une marche dans l'appli, relit le fichier sous Node, vérifie que le rejeu donne les mêmes alertes que le direct, puis rejoue dans l'appli.
- Rejeu en ligne de commande : `node tools/rejeu.mjs fichier.json.gz [--tout] [--inclinaison=enregistree] [--set cle=valeur] [--csv=…] [--json]`.
- Marches synthétiques pour les tests : `tests/fixtures.js` (`makeWalk`) ; les défauts connus y sont reproduits en tests `todo`.

## Carte du code

| Fichier | Rôle |
|---|---|
| `js/app.js` | Application : interface, réglages (`DEFAULTS`, migration `settingsVersion`), commandes vocales (`handleUtterance`), détection de mouvement et d'intérieur, caméra (720p max, 24 i/s), recherche de lieux, export CSV du journal. Expose `window.__oriane` pour les tests |
| `js/alerts.js` | `AlertManager` : suivi des objets, niveaux par type (`PRESETS` aveugle / malvoyant), annonces, bips, vibrations (`VIB`), `events` (journal détaillé). **Cœur de la v2.2** |
| `js/sensors.js` | `TiltFilter` (inclinaison), `MotionState` (marche / immobile). Partagés direct / rejeu. À remplacer par `AttitudeSource` au lot 2.2-1 |
| `js/pipeline.js` | `processFrame` : analyse → correction des distances → intérieur / extérieur (`IndoorDetector`) → alertes → compteur. Même code en direct et au rejeu |
| `js/instruments.js` | `AlertCounter` (H1), `formatEvent`, `eventsToCsv`, résumés |
| `js/rejeu.js` | Format d'enregistrement (gzip JSON, cartes de classes compressées), `Recorder`, `parseRecording`, `ReplaySession` |
| `tools/rejeu.mjs` | Rejeu d'un enregistrement en ligne de commande |
| `js/geometry.js` | `analyze(labels…)` : carte de classes → obstacles (distance, angle, latéral) + bord de trottoir |
| `js/classes.js` | 150 classes ADE20K → 15 familles (`F`), couleurs, `isWalkable` |
| `js/perception.js` / `js/perception-worker.js` | Capture vidéo, envoi au worker, inférence SegFormer, affichage du masque et du couloir |
| `js/vision.js` | Secours COCO-SSD et distance par taille apparente |
| `js/depth.js` | Profondeur Depth Anything (expérimental, non utilisé) |
| `js/nav.js` | Moteur de guidage : suivi de l'itinéraire, virages, repères, écarts, arrivée |
| `js/geo.js` | Géocodage, itinéraire, repères Overpass |
| `js/places.js` | Recherche en langage naturel (`parseRequest`, `findPlaces`), alias d'enseignes, catégories |
| `js/speech.js` | Synthèse vocale à priorités, choix et diagnostic de la voix, reconnaissance |
| `js/wake.js` | Mot d'activation « Dis Oriane » |
| `js/audio.js` | Sons spatialisés, `ping` |
| `js/sim.js` | Simulation de marche le long d'un itinéraire |
| `js/util.js` | Géométrie, formats français, stockage local |
| `tests/core.test.js`, `tests/v2.test.js`, `tests/v22.test.js`, `tests/voix.test.js` | 55 tests unitaires + 2 `todo` (FON-25, FON-28, à corriger au lot 2.2-2) ; `voix.test.js` simule le moteur vocal de Chrome |

## Commandes

```bash
python3 -m http.server 8000      # puis http://localhost:8000
npm test                         # tests unitaires
npm run e2e                      # bout en bout (Playwright)
node tools/rejeu.mjs f.json.gz   # rejeu d'une marche enregistrée
```

Sur téléphone, tester via l'URL GitHub Pages (HTTPS obligatoire pour caméra, capteurs et micro).

## Conventions

- Commentaires et textes en français, phrases courtes ; textes parlés très courts (« Poteau, droite »).
- Chaque nouvelle règle d'alerte : un test unitaire. Avant tout commit : `npm test` vert.
- Mettre à jour `VERSION`, le README et le numéro de migration `settingsVersion` quand les réglages par défaut changent.
- Messages de commit en français, préfixés de la version (« ORIANE v2.2 : … »).

## Documents de référence (hors dépôt)

- Cahier des charges v2 (v0.3), § 15 = spécification et plan v2.2 : Claude Docs « ORIANE v2 — Cahier des charges : détection élargie et alertes de proximité ».
- Projet Claude « ORIANE » : `decisions/priorisation-alertes.md`, `specs/SPEC_CONNEXION_LUNETTES_STAR_GLASSES.md` (confidentiel).
- Feuille de route long terme : Kotlin Multiplatform + Compose Multiplatform (Android d'abord, démo ordinateur, iOS via GitHub Actions macOS + Sideloadly), ONNX Runtime par plateforme, OpenAL Soft ; puis lunettes Blacksheep AG18.
