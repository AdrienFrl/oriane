# ORIANE — Rapport de projet (16 → 20 novembre 2026)

Auteur : Claude (Opus 5.5), pour Adrien Feriolo. Projet scolaire, entièrement gratuit.

## 1. Le projet en bref

ORIANE est une application d'aide à la mobilité pour personnes aveugles et malvoyantes. Elle combine :

- un **guidage piéton vocal** sur OpenStreetMap (virages, repères comme les passages piétons et les feux) ;
- une **détection d'obstacles par la caméra** (téléphone aujourd'hui, lunettes Blacksheep AG18 ensuite) avec des distances approximatives ;
- des **sons spatialisés** (gauche / droite) dont le rythme accélère quand l'obstacle approche, et des vibrations.

ORIANE complète la canne blanche ou le chien guide, elle ne les remplace pas.

- Dépôt public : <https://github.com/AdrienFrl/oriane>
- Prototype en ligne : <https://adrienfrl.github.io/oriane/>
- Téléphone de test : OnePlus Nord 2T (Android, Chrome)

## 2. Chronologie

| Date | Étape | Résultat |
|---|---|---|
| 16/11 | Cadrage : faisabilité, API gratuites, choix OpenStreetMap | Pile 100 % gratuite (Photon, Nominatim, OSRM / OpenRouteService, Overpass) |
| 16/11 | Cahier des charges V1 smartphone, puis cahier des charges général | 2 documents Claude Docs |
| 16/11 | **v1** du prototype web (commit `de88df0`) | Guidage vocal, repères OSM, détection COCO-SSD, sons HRTF, simulation de marche |
| 16/11 | Analyse « détecter murs, portes, poteaux, trottoirs » + cahier des charges v2 (v0.1 → v0.2) | Choix de la segmentation SegFormer-B0 ADE20K ; plan Kotlin Multiplatform ; évolution vers les lunettes |
| 16/11 | Page de réponses aux questions ouvertes | Décisions : véhicules jusqu'à 10 m, mobilier = bip + vibration (voix sous 1,5 m), alerte réglable 2–6 m, utilisateurs de 1,60 à 1,90 m |
| 16–20/11 | **v2** (commit `ef1d44c`) | Segmentation de scène dans un worker, distances au sol, couloir de marche, recherche de lieux en langage naturel, mot d'activation « Dis Oriane », détection indépendante du guidage, caméra 720p |
| 20/11 | Correctif voix OnePlus (commit `f7e48cd`) | Choix de la voix, diagnostic, bandeau d'alerte si la synthèse reste muette |
| 20/11 | Questionnaire de priorisation (artefact) | Table de niveaux par type d'obstacle |
| 20/11 | **v2.1** (commit `b9af072`) | Priorisation des alertes, profils aveugle / malvoyant, silence à l'arrêt, « silence / reprends », détection intérieur / extérieur |
| 20/11 | Test terrain : encore trop d'alertes | Diagnostic de deux erreurs de conception |
| 20/11 | Recherche + catalogue de 56 propositions (artefact) | Choix d'Adrien enregistrés |
| 20/11 | Cahier des charges **v0.3** : § 15 anti-surcharge et plan v2.2 | Spécification FON-20 à FON-41, plan en 6 lots |

## 3. Ce qui fonctionne aujourd'hui (v2.1)

- **Guidage** : recherche « aller à Inter à Castelsarrasin », « la pharmacie la plus proche » ; liste de 3 propositions numérotées ; « ok » lance le guidage ; virages et repères annoncés ; recalcul en cas d'écart ; simulation de marche pour tester chez soi.
- **Détection** : SegFormer-B0 (150 classes ADE20K regroupées en 15 familles : sol, chaussée, mur, porte, vitre, poteau, poubelle, mobilier, escalier, personne, véhicule, arbre, eau, obstacle inconnu…). WebGPU si disponible, sinon processeur (WASM, modèle quantifié 4,4 Mo). COCO-SSD en secours.
- **Distance** : géométrie au sol à partir de la hauteur du téléphone et de son inclinaison (`d = h / tan(inclinaison + angle du pixel)`).
- **Alertes** : couloir de marche, hystérésis, suivi des objets, niveaux par type, profil aveugle / malvoyant, bips spatialisés, vibrations, voix avec file à priorités.
- **Mains libres** : « Dis Oriane » + commandes (destination, détection, silence, reprends…).
- **Confidentialité** : les images ne quittent jamais le téléphone ; la clé OpenRouteService reste sur le téléphone.
- **Tests** : 31 tests unitaires (`node --test`) + tests de bout en bout Puppeteer (fausse caméra, faux modèle, services OSM simulés).

## 4. Problèmes connus

1. **Trop d'alertes** (test du 20/11) :
   - voitures garées annoncées comme « véhicule qui approche » : la vitesse de marche de l'utilisateur n'est pas retirée de la vitesse de rapprochement ;
   - personnes marchant dans le même sens annoncées : l'inclinaison du téléphone oscille à chaque pas et fait « sauter » les distances (±50 cm à 4 m), et la règle « se rapproche » ne compare que deux mesures.
2. **Voix muette sur le OnePlus** : contournement par le choix de la voix ou le moteur « Services vocaux Google » ; à confirmer.
3. Limites : types de portes non distingués, vitre détectée seulement comme « vitre », bord de trottoir déduit de la frontière trottoir / chaussée, mains libres seulement écran allumé, licence SegFormer non commerciale.

## 5. Recherche du 20/11 (synthèse)

- **Systèmes existants** : Biped NOA prédit les trajectoires et ignore les objets proches sans risque de collision ; le détecteur de Mass. Eye and Ear alerte sur le temps avant collision, pas sur la proximité ; Soundscape propose des catégories d'annonces, un interrupteur général et des informations à la demande ; Apple Loupe ne donne que la personne la plus proche quand il y en a plusieurs ; WeWALK se limite aux obstacles en hauteur (la canne gère le sol) ; des utilisateurs de NOA ont trouvé les sons trop fréquents et trop forts.
- **Perception** : les personnes aveugles s'appuient fortement sur l'ouïe (chaque son d'ORIANE en masque un autre) ; la localisation gauche / droite est bonne, la hauteur moins ; les motifs de vibration distincts sont bien reconnus ; l'urgence d'un son est surtout portée par son rythme ; avec une vision en tunnel, les collisions viennent des côtés.
- **Principe retenu** : silence par défaut, alerte sur le risque de collision, vibration d'abord, voix si nécessaire.

## 6. Décisions d'Adrien sur le catalogue (20/11)

- **Retenues** : A1–A6, B1–B4, B8 (sauf reprise de marche vers l'obstacle), B9, B10, C1, C2, C5 (mode par défaut « détection + mains libres », guidage seul sur demande), D2 (volume qui monte pour un danger qui approche), D3–D6, E1, F3, F4, G6, H3 (activable).
- **À tester** : A7, A8, B5, B6, B7, C3, C4 (si le mode « sur demande » est choisi), D1, F5, H1 (bêta).
- **Plus tard** : D7, D8, D9, E2 (avec les lunettes), E4, F1, F6, G1–G5, H2, H4, H5.
- **Écartées** : C6, F2.
- **Modifiée** : E3 → vibrations en priorité, voix si cela ne suffit pas.
- **À préciser** : A9, C7.

## 7. Plan de développement v2.2 (rien n'est encore codé)

| Lot | Contenu | Effort |
|---|---|---|
| 2.2-0 Instruments | Journal détaillé, compteur d'alertes par minute, enregistrement et rejeu d'une marche | M |
| 2.2-1 Mesure | Orientation lissée (source interchangeable téléphone / lunettes), vitesse de marche, confirmation 4/6, tendance sur 1,5 s, filtre de Kalman | M |
| 2.2-2 Décision | Temps avant collision, trajectoire prédite, même sens, véhicule garé, éléments longés, couloir sur le cap, pause après alerte, mémoire des lieux | L |
| 2.2-3 Restitution | Escalade vibration → voix → stop, vocabulaire tactile, sons au rythme du TTC, phrases de 2 mots, file de parole unique | M |
| 2.2-4 Modes et contrôle | Mode par défaut, modes de scène, foule, « Qu'y a-t-il devant ? », bavardage en 3 crans | M |
| 2.2-5 Recette terrain | Réglage des seuils sur le OnePlus, publication | S |

Ensuite : Kotlin Multiplatform + Android, démo ordinateur, lunettes AG18, iOS (compilation via GitHub Actions macOS, installation par Sideloadly).

## 8. Livrables produits

| Livrable | Où |
|---|---|
| Code du prototype (v1 → v2.1) | <https://github.com/AdrienFrl/oriane> |
| Prototype en ligne | <https://adrienfrl.github.io/oriane/> |
| Cahier des charges v2 (v0.3, § 15 = v2.2) | Claude Docs : « ORIANE v2 — Cahier des charges : détection élargie et alertes de proximité » |
| Cahiers des charges V1 et général | Claude Docs |
| Page de réponses aux questions ouvertes | Artefact « ORIANE — Tes réponses au cahier des charges » |
| Questionnaire de priorisation | Artefact « ORIANE — Questionnaire de priorisation des alertes » |
| Catalogue anti-surcharge (56 propositions + recherche) | Artefact « ORIANE — Catalogue anti-surcharge des alertes » |
| Décisions de priorisation | Projet Claude « ORIANE » : `decisions/priorisation-alertes.md` |
| Spécification de connexion aux lunettes (confidentielle) | Projet Claude « ORIANE » : `specs/SPEC_CONNEXION_LUNETTES_STAR_GLASSES.md` — **ne jamais copier dans le dépôt public** |
| CLAUDE.md, HANDOFF.md, ce rapport | Dossier `source/` du dépôt |
