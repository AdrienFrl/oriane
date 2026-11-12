# ORIANE — prototype web

Guidage piéton vocal et détection d'obstacles par la caméra, pour personnes aveugles et malvoyantes.
Prototype d'étude : **ORIANE complète la canne blanche ou le chien guide, il ne les remplace pas.**

Tout est gratuit : aucune carte bancaire, aucun compte payant.

## Tester sur le téléphone

1. Ouvrir le lien GitHub Pages dans **Chrome sur Android**.
2. Autoriser la **position**, le **micro** et la **caméra** quand Chrome le demande.
3. Mettre des **écouteurs stéréo** pour entendre les sons spatialisés.
4. Appuyer sur **Parler** et dire une adresse, par exemple « 18 rue de Metz à Toulouse ».
5. Répondre « oui » pour partir.

Astuce : menu Chrome ⋮ → **Ajouter à l'écran d'accueil** pour l'ouvrir comme une application.

### Tester sans sortir

Réglages → cocher **Simulation de marche** (vitesse × 3 ou × 10). Le parcours est alors joué
virtuellement depuis votre position réelle, avec toutes les annonces vocales.

## Commandes vocales

| Dire | Effet |
|---|---|
| une adresse ou un lieu | recherche, puis « oui » / « non » pour choisir |
| « répète » | redit la prochaine consigne |
| « où suis-je » | adresse approximative actuelle |
| « distance » / « combien reste-t-il » | distance et temps restants |
| « qu'y a-t-il devant moi » | décrit les objets détectés |
| « active la détection » / « coupe la détection » | caméra |
| « arrête le guidage » | fin du guidage |
| « aide » | rappel des commandes |

## Fonctionnement

| Fonction | Outil gratuit |
|---|---|
| Reconnaissance et synthèse vocales | API Web Speech de Chrome |
| Recherche d'adresse | Photon (Komoot), secours Nominatim — OpenStreetMap |
| Itinéraire à pied | OpenRouteService (clé gratuite facultative) ou OSRM « foot » de FOSSGIS |
| Passages piétons et feux | API Overpass — OpenStreetMap |
| Détection d'objets | TensorFlow.js + COCO-SSD, sur le téléphone |
| Profondeur (expérimental) | Depth Anything V2 Small via Transformers.js, sur le téléphone |
| Sons 3D | Web Audio (HRTF) |

**Distance des objets** : taille réelle moyenne de l'objet × focale ÷ taille dans l'image.
Approximative (± 20 à 30 %) ; réglable dans *Réglages → Correction des distances*.

**Bips d'obstacles** : chaque obstacle (jusqu'à 3) est un son placé dans l'espace selon sa direction.
Plus il est proche, plus les bips sont rapides, forts et aigus ; ils deviennent quasi continus sous 80 cm.
Les objets reconnus sonnent en sinus, les obstacles vus par la profondeur en triangle (plus grave).

**Profondeur (expérimental)** : le modèle donne une profondeur relative. Elle est mise à l'échelle
en supposant que le bas de l'image est le sol, grâce à la hauteur du téléphone et à son inclinaison.
Tout ce qui dépasse nettement du sol devient un obstacle (poteau, mur, poubelle…).

### Clé OpenRouteService (facultative)

Sans clé, l'itinéraire passe par OSRM (FOSSGIS), qui fonctionne bien. Pour OpenRouteService :
inscription gratuite sur <https://openrouteservice.org/dev/#/signup>, puis coller la clé dans
*Réglages → Itinéraire*. La clé est enregistrée uniquement sur le téléphone, jamais dans ce dépôt.

## Limites connues

- GPS urbain à ± 5–10 m : les consignes s'appuient sur des repères plutôt que sur des distances exactes.
- Les passages piétons proches du trajet peuvent concerner une rue voisine.
- La couleur des feux est une estimation expérimentale : ne jamais traverser sur cette seule base.
- Écran allumé nécessaire (verrouillage de l'écran évité automatiquement quand c'est possible).
- La version web ne fonctionne pas en arrière-plan ; ce sera le rôle de l'application Android native.

## Développement

Site statique, sans étape de compilation : `index.html`, `css/`, `js/`.

```bash
python3 -m http.server 8000   # puis http://localhost:8000
npm test                      # tests de la logique (Node 20+)
```

Données cartographiques © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright).
