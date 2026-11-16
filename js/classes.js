// ORIANE v2 — classes du modèle de segmentation ADE20K (SegFormer-B0) regroupées en familles.
// Liste vérifiée sur le config.json de Xenova/segformer-b0-finetuned-ade-512-512 (150 classes).

export const ADE_LABELS = [
  'wall', 'building', 'sky', 'floor', 'tree', 'ceiling', 'road', 'bed', 'windowpane', 'grass',
  'cabinet', 'sidewalk', 'person', 'earth', 'door', 'table', 'mountain', 'plant', 'curtain', 'chair',
  'car', 'water', 'painting', 'sofa', 'shelf', 'house', 'sea', 'mirror', 'rug', 'field',
  'armchair', 'seat', 'fence', 'desk', 'rock', 'wardrobe', 'lamp', 'bathtub', 'railing', 'cushion',
  'base', 'box', 'column', 'signboard', 'chest of drawers', 'counter', 'sand', 'sink', 'skyscraper', 'fireplace',
  'refrigerator', 'grandstand', 'path', 'stairs', 'runway', 'case', 'pool table', 'pillow', 'screen door', 'stairway',
  'river', 'bridge', 'bookcase', 'blind', 'coffee table', 'toilet', 'flower', 'book', 'hill', 'bench',
  'countertop', 'stove', 'palm', 'kitchen island', 'computer', 'swivel chair', 'boat', 'bar', 'arcade machine', 'hovel',
  'bus', 'towel', 'light', 'truck', 'tower', 'chandelier', 'awning', 'streetlight', 'booth', 'television receiver',
  'airplane', 'dirt track', 'apparel', 'pole', 'land', 'bannister', 'escalator', 'ottoman', 'bottle', 'buffet',
  'poster', 'stage', 'van', 'ship', 'fountain', 'conveyer belt', 'canopy', 'washer', 'plaything', 'swimming pool',
  'stool', 'barrel', 'basket', 'waterfall', 'tent', 'bag', 'minibike', 'cradle', 'oven', 'ball',
  'food', 'step', 'tank', 'trade name', 'microwave', 'pot', 'animal', 'bicycle', 'lake', 'dishwasher',
  'screen', 'blanket', 'sculpture', 'hood', 'sconce', 'vase', 'traffic light', 'tray', 'ashcan', 'fan',
  'pier', 'crt screen', 'plate', 'monitor', 'bulletin board', 'shower', 'radiator', 'glass', 'clock', 'flag',
];

// Familles (codes compacts pour le worker).
export const F = {
  SOL: 0, CHAUSSEE: 1, IGNORE: 2, MUR: 3, PORTE: 4, VITRE: 5, POTEAU: 6, POUBELLE: 7,
  MOBILIER: 8, ESCALIER: 9, PERSONNE: 10, VEHICULE: 11, ARBRE: 12, EAU: 13, OBSTACLE: 14,
};
export const FAMILY_NAMES = ['sol', 'chaussée', 'ignoré', 'mur', 'porte', 'vitre', 'poteau', 'poubelle',
  'mobilier', 'escalier', 'personne', 'véhicule', 'arbre', 'eau', 'obstacle'];
export const isWalkable = (f) => f === F.SOL || f === F.CHAUSSEE;

// Couleurs du masque affiché en mode testeur (RGBA), par famille.
export const FAMILY_COLORS = [
  [60, 200, 120, 70], [120, 120, 140, 70], [0, 0, 0, 0], [240, 90, 70, 120], [250, 170, 40, 150],
  [80, 200, 250, 150], [255, 60, 200, 170], [180, 120, 60, 170], [250, 220, 60, 140], [170, 90, 250, 160],
  [255, 255, 255, 140], [250, 60, 60, 160], [40, 140, 60, 120], [40, 110, 250, 140], [255, 140, 140, 120],
];

const RULES = {
  // Sol praticable
  floor: [F.SOL], sidewalk: [F.SOL], path: [F.SOL], rug: [F.SOL], earth: [F.SOL], grass: [F.SOL],
  field: [F.SOL], sand: [F.SOL], land: [F.SOL], 'dirt track': [F.SOL], runway: [F.SOL], pier: [F.SOL],
  bridge: [F.SOL], road: [F.CHAUSSEE],
  // Rien à signaler (loin ou en hauteur)
  sky: [F.IGNORE], ceiling: [F.IGNORE], mountain: [F.IGNORE], hill: [F.IGNORE], light: [F.IGNORE],
  chandelier: [F.IGNORE], sconce: [F.IGNORE], awning: [F.IGNORE], canopy: [F.IGNORE], flag: [F.IGNORE],
  clock: [F.IGNORE], painting: [F.IGNORE], poster: [F.IGNORE], blind: [F.IGNORE], airplane: [F.IGNORE],
  'trade name': [F.IGNORE], 'bulletin board': [F.IGNORE], hood: [F.IGNORE],
  // Murs et barrières
  wall: [F.MUR, 'mur'], building: [F.MUR, 'mur'], house: [F.MUR, 'mur'], skyscraper: [F.MUR, 'mur'],
  hovel: [F.MUR, 'mur'], tower: [F.MUR, 'mur'], fence: [F.MUR, 'barrière'], railing: [F.MUR, 'rambarde'],
  bannister: [F.MUR, 'rampe'], grandstand: [F.MUR, 'gradins'],
  // Portes (battantes, à poignée, poussantes : classe « door »)
  door: [F.PORTE, 'porte'], 'screen door': [F.PORTE, 'porte'],
  // Vitres : portes automatiques et coulissantes vitrées, vitrines
  windowpane: [F.VITRE, 'porte ou paroi vitrée'], mirror: [F.VITRE, 'miroir'], case: [F.VITRE, 'vitrine'],
  // Poteaux et mâts
  pole: [F.POTEAU, 'poteau'], column: [F.POTEAU, 'pilier'], streetlight: [F.POTEAU, 'lampadaire'],
  signboard: [F.POTEAU, 'panneau'], 'traffic light': [F.POTEAU, 'feu'],
  // Poubelles
  ashcan: [F.POUBELLE, 'poubelle'], barrel: [F.POUBELLE, 'tonneau'],
  // Mobilier
  bed: [F.MOBILIER, 'lit'], cabinet: [F.MOBILIER, 'meuble'], table: [F.MOBILIER, 'table'],
  chair: [F.MOBILIER, 'chaise'], sofa: [F.MOBILIER, 'canapé'], shelf: [F.MOBILIER, 'étagère'],
  armchair: [F.MOBILIER, 'fauteuil'], seat: [F.MOBILIER, 'siège'], desk: [F.MOBILIER, 'bureau'],
  wardrobe: [F.MOBILIER, 'armoire'], lamp: [F.MOBILIER, 'lampe'], bathtub: [F.MOBILIER, 'baignoire'],
  cushion: [F.MOBILIER, 'coussin'], box: [F.MOBILIER, 'carton'], 'chest of drawers': [F.MOBILIER, 'commode'],
  counter: [F.MOBILIER, 'comptoir'], sink: [F.MOBILIER, 'lavabo'], fireplace: [F.MOBILIER, 'cheminée'],
  refrigerator: [F.MOBILIER, 'réfrigérateur'], 'pool table': [F.MOBILIER, 'billard'], pillow: [F.MOBILIER, 'coussin'],
  bookcase: [F.MOBILIER, 'bibliothèque'], 'coffee table': [F.MOBILIER, 'table basse'], toilet: [F.MOBILIER, 'toilettes'],
  bench: [F.MOBILIER, 'banc'], countertop: [F.MOBILIER, 'plan de travail'], stove: [F.MOBILIER, 'cuisinière'],
  'kitchen island': [F.MOBILIER, 'îlot'], computer: [F.MOBILIER, 'ordinateur'], 'swivel chair': [F.MOBILIER, 'chaise'],
  bar: [F.MOBILIER, 'bar'], 'arcade machine': [F.MOBILIER, 'borne'], booth: [F.MOBILIER, 'cabine'],
  'television receiver': [F.MOBILIER, 'télévision'], ottoman: [F.MOBILIER, 'pouf'], buffet: [F.MOBILIER, 'buffet'],
  washer: [F.MOBILIER, 'machine à laver'], stool: [F.MOBILIER, 'tabouret'], basket: [F.MOBILIER, 'panier'],
  cradle: [F.MOBILIER, 'berceau'], oven: [F.MOBILIER, 'four'], dishwasher: [F.MOBILIER, 'lave-vaisselle'],
  radiator: [F.MOBILIER, 'radiateur'], plant: [F.MOBILIER, 'plante'], pot: [F.MOBILIER, 'pot'],
  vase: [F.MOBILIER, 'vase'], flower: [F.MOBILIER, 'fleurs'], sculpture: [F.MOBILIER, 'sculpture'],
  fan: [F.MOBILIER, 'ventilateur'], shower: [F.MOBILIER, 'douche'], tent: [F.MOBILIER, 'tente'],
  'conveyer belt': [F.MOBILIER, 'tapis roulant'], stage: [F.MOBILIER, 'estrade'], base: [F.MOBILIER, 'socle'],
  // Escaliers
  stairs: [F.ESCALIER, 'escalier'], stairway: [F.ESCALIER, 'escalier'], step: [F.ESCALIER, 'marche'],
  escalator: [F.ESCALIER, 'escalator'],
  // Personnes et véhicules
  person: [F.PERSONNE, 'personne'], animal: [F.PERSONNE, 'animal'],
  car: [F.VEHICULE, 'voiture'], bus: [F.VEHICULE, 'bus'], truck: [F.VEHICULE, 'camion'], van: [F.VEHICULE, 'camionnette'],
  minibike: [F.VEHICULE, 'moto'], bicycle: [F.VEHICULE, 'vélo'], boat: [F.VEHICULE, 'bateau'], ship: [F.VEHICULE, 'bateau'],
  // Végétation et eau
  tree: [F.ARBRE, 'arbre'], palm: [F.ARBRE, 'palmier'], rock: [F.OBSTACLE, 'rocher'],
  water: [F.EAU, 'eau'], sea: [F.EAU, 'eau'], river: [F.EAU, 'eau'], lake: [F.EAU, 'eau'],
  'swimming pool': [F.EAU, 'piscine'], waterfall: [F.EAU, 'eau'], fountain: [F.EAU, 'fontaine'],
};

/** Pour chaque index de classe : { family, fr }. */
export const CLASS_TABLE = ADE_LABELS.map((name) => {
  const r = RULES[name];
  if (!r) return { name, family: F.OBSTACLE, fr: 'obstacle' };
  return { name, family: r[0], fr: r[1] || FAMILY_NAMES[r[0]] };
});

export const CLASS_FAMILY = Uint8Array.from(CLASS_TABLE.map((c) => c.family));
