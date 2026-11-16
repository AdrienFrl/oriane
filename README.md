# ORIANE v2 — prototype web

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

## Ce que détecte la v2

| Famille | Exemples | Alerte |
|---|---|---|
| Murs, barrières | mur, façade, barrière, rambarde | voix + bip |
| Portes | portes à poignée, poussantes, battantes | voix + bip |
| Vitres | portes automatiques et coulissantes vitrées, vitrines | voix + bip (« porte ou paroi vitrée ») |
| Poteaux | poteau, pilier, lampadaire, panneau, feu | voix + bip |
| Poubelles | poubelle, tonneau | voix + bip |
| Mobilier | chaise, table, banc, plante, carton… | bip + vibration, voix seulement sous 1,5 m |
| Escaliers | escalier, marche, escalator | voix + bip |
| Personnes, véhicules | personne, voiture, vélo, moto, bus | voix + bip ; véhicule qui approche annoncé jusqu'à 10 m |
| Bord de trottoir | limite trottoir / chaussée | voix |
| Autre | tout ce qui n'est pas du sol sur le chemin | « obstacle » |

Règles (cahier des charges § 4.2) :
- Alerte seulement **dans le couloir de marche** (1,5 m de large, réglable) et **à moins de 4 m** (réglable de 2 à 6 m).
- Une seule annonce à l'entrée dans la zone ; hystérésis de 0,6 m pour éviter les répétitions.
- **Urgence sous 1,5 m** : « Stop, mur devant », vibration, priorité sur toute autre phrase.
- Obstacle frôlé sur le côté (hors couloir, à moins de 2 m) : bip discret seulement.
- Téléphone trop incliné ou image trop sombre : message d'avertissement.

## Commandes vocales

| Dire | Effet |
|---|---|
| « Dis Oriane » (mode mains libres) | ORIANE écoute la suite : un lieu ou une commande |
| un lieu, une enseigne, une catégorie, une adresse | recherche, propositions numérotées, puis guidage |
| « oui », « ok », « deux », « trois », « suivant » | choix parmi les propositions |
| « active la détection » / « arrête la détection » | détection d'obstacles |
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
distance, bord de trottoir en pointillés violets. Journal exportable en CSV (Réglages → Journal).

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
python3 -m http.server 8000   # puis http://localhost:8000
npm test                      # tests de la logique (Node 20+)
```

Données cartographiques © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright).
