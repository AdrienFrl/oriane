# ORIANE v2.2-0.1 — prototype web

Guidage piéton vocal et détection d'obstacles par la caméra, pour personnes aveugles et malvoyantes.
Prototype d'étude : **ORIANE complète la canne blanche ou le chien guide, il ne les remplace pas.**
L'absence d'alerte ne garantit pas l'absence d'obstacle.

Tout est gratuit : aucune carte bancaire, aucun compte payant. Les images de la caméra restent sur le téléphone.

Lien de test : <https://adrienfrl.github.io/oriane/>

## Tester sur le téléphone

1. Ouvrir le lien dans **Chrome sur Android** et autoriser **position**, **micro** et **caméra**.
2. Mettre des **écouteurs stéréo** pour les sons spatialisés.
3. **Détection** : bouton « Activer la détection » ou dire « active la détection ». Elle marche avec ou sans guidage.
   Téléphone tenu à la poitrine, caméra vers l'avant et légèrement vers le sol.
4. **Destination** : appuyer sur **Parler** (ou dire « Dis Oriane » en mode mains libres) puis dire un lieu :
   « Intermarché à Montauban », « la pharmacie la plus proche », « 18 rue de Metz à Toulouse ».
   ORIANE propose jusqu'à 3 lieux numérotés : « oui » ou « ok » pour le premier, « deux », « trois », ou « suivant ».
   Le guidage démarre tout seul.

Le premier lancement de la détection télécharge le modèle de scène (≈ 15 Mo), gardé ensuite en cache.

### Tester sans sortir

Réglages → **Simulation de marche** (× 3 ou × 10) : le trajet est joué virtuellement depuis votre position.

## Enregistrer et rejouer une marche (v2.2-0, outils de test)

La v2.2 réduit les fausses alertes. Pour régler les seuils sur de vraies marches, ORIANE peut les enregistrer :

1. **Outils de test** → cocher **Enregistrement et rejeu de marches**.
2. **Enregistrer une marche** (ou « Dis Oriane, commence l'enregistrement ») : la détection démarre, marchez normalement.
3. **Arrêter et enregistrer le fichier** (ou « Dis Oriane, arrête l'enregistrement ») : un fichier
   `oriane-rejeu-….json.gz` est téléchargé sur le téléphone (environ 3 Mo par minute avec les images, estimation ; 10 min au plus).
4. **Rejouer** : choisir le fichier, puis **Analyser** (toutes les alertes et le résumé, instantanément) ou
   **Rejouer en temps réel** (images, zones reconnues, sons et voix, comme pendant la marche). Fonctionne aussi sur ordinateur.

Le fichier contient les images basse définition (224 px) vues par le modèle, les zones reconnues, l'orientation,
l'accéléromètre et le GPS. Il reste sur le téléphone tant que vous ne le partagez pas vous-même.
L'option « Garder les images » permet de l'enregistrer sans images.

Autres outils :
- **Compteur d'alertes** (bêta) dans la ligne d'état : alertes de la dernière minute, et moyenne par minute de marche
  (cible v2.2 : 2 au plus hors danger, en rue calme).
- **Journal détaillé** : chaque alerte avec sa raison, la vitesse de rapprochement et le temps avant collision (TTC) ;
  en option, les alertes retenues et pourquoi (immobile, silence, niveau…). Export CSV : Journal → Exporter les alertes détaillées.
- Sur ordinateur : `node tools/rejeu.mjs fichier.json.gz [--tout] [--set alertRange=4] [--set levels.poteau=jamais] [--csv=sortie.csv]`.

## Priorisation des alertes (v2.1, questionnaire du 20/11/2026)

| Niveau | Effet | Types d'obstacles (profil aveugle) |
|---|---|---|
| 1 · Danger permanent | voix + vibration longue dès l'entrée dans la zone, coupe tout | véhicule qui approche (jusqu'à 10 m), escalier, vitre / porte vitrée |
| 2 · Bip + phrase | un bip, puis « Personne, 3 mètres, devant » (bip seul pendant un guidage) | personne |
| 2 · Bip seul | un bip ; la phrase seulement en danger | poteau, poubelle, bord de trottoir, obstacle non reconnu |
| 3 · Vibration | vibration courte ; la phrase seulement en danger | porte, mobilier, eau |
| 3 · Danger seulement | rien, sauf sous 1,5 m | mur, véhicule à l'arrêt, végétation |

Règles communes :
- Zone surveillée : **3 m** devant, couloir de **1,2 m** ; danger sous **1,5 m** : « Stop, poteau, devant », vibration longue.
- **Un seul bip** à l'apparition ; bips continus seulement sous 2 m, pour l'obstacle le plus proche.
- **Immobile : silence**, sauf danger. Annonce seulement si l'obstacle **se rapproche**.
- 2 s minimum entre deux annonces, sans limite par minute ; obstacles apparus ensemble : « Plusieurs obstacles. » + le plus important.
- Pas de répétition, sauf si l'obstacle devient dangereux.
- **Intérieur** (détecté automatiquement) : murs signalés seulement droit devant, à moins de 2 m.
- « **Dis Oriane, silence** » : seuls les dangers et le niveau 1 restent, jusqu'à « Dis Oriane, reprends ».
- Vibrations : longue = danger, courte = information, triple = commande comprise.
- Profil « malvoyant » disponible (moins d'alertes) ; chaque niveau est réglable dans Réglages → Priorités.

Familles reconnues : murs et barrières, portes, vitres, poteaux et panneaux, poubelles, mobilier, escaliers,
personnes, véhicules, végétation, eau, bord de trottoir, et tout autre obstacle sur le chemin.

## Commandes vocales

| Dire | Effet |
|---|---|
| « Dis Oriane » (mode mains libres) | ORIANE écoute la suite : un lieu ou une commande |
| un lieu, une enseigne, une catégorie, une adresse | recherche, propositions numérotées, puis guidage |
| « oui », « ok », « deux », « trois », « suivant » | choix parmi les propositions |
| « active la détection » / « arrête la détection » | détection d'obstacles |
| « silence » / « reprends » | coupe les alertes non urgentes / les rétablit |
| « commence l'enregistrement » / « arrête l'enregistrement » | enregistre une marche (outils de test) |
| « qu'y a-t-il devant moi » | décrit ce que voit la caméra |
| « répète », « où suis-je », « combien reste-t-il » | guidage |
| « arrête le guidage », « aide » | |

Mode mains libres : l'écran doit rester allumé ; Android peut émettre un petit son à chaque relance de l'écoute.

## Fonctionnement

| Fonction | Outil gratuit |
|---|---|
| Reconnaissance et synthèse vocales | API Web Speech de Chrome |
| Segmentation de la scène | SegFormer-B0 ADE20K (`Xenova/segformer-b0-finetuned-ade-512-512`) via Transformers.js 3, dans un Web Worker, WebGPU sinon processeur |
| Distance des obstacles | point de contact au sol, hauteur et inclinaison du téléphone (`js/geometry.js`) |
| Alertes | `js/alerts.js` (couloir, zones, hystérésis, urgence, véhicules) |
| Secours si le modèle ne charge pas | COCO-SSD (TensorFlow.js), détecteur de la v1 |
| Recherche de lieux | Overpass (lieux autour de soi), Photon, Nominatim — OpenStreetMap |
| Itinéraire à pied | OpenRouteService (clé facultative) ou OSRM « foot » de FOSSGIS |
| Passages piétons et feux | API Overpass |
| Sons 3D | Web Audio (HRTF) ; vibrations : API Vibration |

Vidéo : 720p maximum (480p en option) ; l'analyse porte sur une image réduite à 224 px de large,
de 4 à 8 fois par seconde, pour limiter la latence.

Mode testeur : couleurs des zones reconnues, couloir surveillé en jaune, obstacles suivis avec leur
distance, bord de trottoir en pointillés violets. Journal exportable en CSV (Journal).

## Si la voix ne sort pas (constaté sur OnePlus)

Réglages → Voix → **Tester la voix** affiche les voix françaises disponibles. Essayer une autre voix dans
« Voix utilisée », vérifier le volume Multimédia, sinon : Paramètres Android → Paramètres supplémentaires →
Langues et saisie → Synthèse vocale → moteur « Services vocaux Google », langue Français, voix française téléchargée.

Depuis la v2.2-0.1, ORIANE parle comme la v1 : avec la **voix Google de Chrome** si elle est listée, sinon avec
la voix française par défaut de Chrome. Une liste de voix vide (fréquente sur Android) n'empêche plus de parler.
Le réglage « Voix utilisée » reste disponible pour choisir une autre voix ; si elle échoue, la phrase est redite
avec la voix de Chrome (journal : « 🔁 »). En mode mains libres, la voix attend que le micro soit libéré.

## Limites connues

- Distances approximatives : elles supposent un sol plat et dépendent de la hauteur et de l'inclinaison du téléphone.
- Portes vitrées et vitrines : reconnues comme « vitre » quand le modèle les voit ; une paroi très transparente peut être manquée.
- Le type de porte (poignée, coulissante, poussante) n'est pas distingué : elles sont annoncées « porte ».
- Bord de trottoir déduit de la limite trottoir / chaussée : manqué si les deux surfaces se ressemblent.
- Version web : pas de fonctionnement écran éteint (rôle de l'application Android native, lot 5).
- Le modèle SegFormer est sous licence NVIDIA non commerciale : acceptable pour un projet d'école, à remplacer pour un produit.

## Développement

Site statique sans compilation : `index.html`, `css/`, `js/`.

```bash
python3 -m http.server 8000           # puis http://localhost:8000
npm test                              # tests de la logique (Node 20+)
npm run e2e                           # bout en bout : enregistrement et rejeu (Playwright + Chromium)
node tools/rejeu.mjs fichier.json.gz  # rejouer une marche enregistrée
```

Les règles d'alerte et le traitement des analyses sont des modules purs, partagés par le direct et le rejeu :
`js/sensors.js` (inclinaison, marche), `js/pipeline.js` (analyse → alertes), `js/alerts.js`, `js/instruments.js`
(compteur, journal), `js/rejeu.js` (format d'enregistrement, rejeu).

Données cartographiques © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright).
