# HANDOFF — reprise du projet ORIANE

Date : 20/11/2026. État laissé par la session précédente (Claude, claude.ai). Lire aussi `source/CLAUDE.md` et `source/RAPPORT.md`.

## Où on en est

- **v2.1 en ligne** (commit `b9af072` sur `main`, GitHub Pages). 31 tests unitaires verts, e2e vert.
- Test terrain d'Adrien sur OnePlus Nord 2T : **encore trop d'alertes**. Diagnostic fait (ci-dessous), rien n'est encore corrigé dans le code.
- Recherche et catalogue de 56 propositions remplis par Adrien ; décisions intégrées au cahier des charges v0.3 (§ 15).
- Adrien a demandé de **ne pas développer tout de suite** : la prochaine session commence la v2.2 seulement quand il le demande.
- Fichiers de reprise poussés sur `main` le 20/11/2026 dans le dossier `source/` : `CLAUDE.md`, `HANDOFF.md`, `RAPPORT.md`.

## Diagnostic à corriger en premier (dans `js/alerts.js`)

1. **Voitures garées = « véhicule qui approche »** : dans la boucle `vehicule_approche`, `speed = (h0.d - tr.distance) / dt` n'est pas corrigée de la vitesse de marche (~1,3 m/s). Avec le bruit, le seuil `speed > 1.5` est franchi. → vitesse propre = rapprochement − vitesse de marche (FON-20, FON-25).
2. **Personnes dans le même sens annoncées** : `_approaching(tr)` = baisse ≥ 0,15 m sur ≥ 0,4 s entre deux points ; l'inclinaison (`deviceorientation` beta) oscille à chaque pas → ±50 cm à 4 m. → lissage de l'orientation, régression sur 1,5 s, Kalman, règle « même sens » (FON-21, 22, 23, 28).

## Décisions d'Adrien (catalogue du 20/11)

- Retenues : A1 vitesse propre · A2 lissage de l'inclinaison, **avec une source d'orientation interchangeable (téléphone, puis lunettes ou caméra connectée)** · A3 tendance 1,5 s · A4 Kalman · A5 confirmation 4/6 · A6 véhicule garé = décor · B1 temps avant collision · B2 trajectoire prédite · B3 même sens · B4 couloir sur le cap · B8 pause de 3 s après alerte, **sauf reprise de marche vers l'obstacle** · B9 mémoire des lieux · B10 éléments longés · C1 modes de scène · C2 mode foule · C5 **défaut = détection + mains libres, guidage seul sur demande** · D2 urgence par le rythme, **volume qui monte pour un danger qui approche** · D3 plus de bips continus automatiques · D4 phrases de 2 mots · D5 file de parole unique · D6 son 3D gauche/centre/droite · E1 vocabulaire de 4 vibrations · F3 « Qu'y a-t-il devant ? » · F4 bavardage 3 crans · G6 vitesse personnelle · H3 enregistrement/rejeu **activable**.
- À tester (interrupteurs expérimentaux) : A7 étalonnage · A8 images secouées · B5 hauteur · B6 score de risque · B7 budget/minute · C3 traversée · C4 « sur demande » · D1 son par famille · F5 « fausse alerte » · H1 compteur (bêta).
- Plus tard : D7, D8, D9, E2 (avec les lunettes), E4, F1, F6, G1–G5, H2, H4, H5. Écartées : C6, F2.
- **E3 modifiée** : vibration en priorité, voix seulement si la vibration ne suffit pas (escalade vibration → phrase → « Stop »).
- En attente d'une réponse d'Adrien : A9 (distance quand le pied de l'objet est caché derrière un autre) et C7 (lieux familiers = trajets marqués « connus » avec moins d'annonces).

## Plan v2.2 (cahier des charges § 15.7)

| Lot | Contenu | Fin de lot |
|---|---|---|
| 2.2-0 Instruments | Journal détaillé (raison, TTC, vitesse), compteur/minute (bêta), enregistrement + rejeu d'une marche (images 224 px, capteurs) | Adrien enregistre 3 rejeux : voitures garées, suivre un piéton, longer une façade |
| 2.2-1 Mesure | `AttitudeSource` + lissage, podomètre, confirmation 4/6, régression 1,5 s, Kalman | Distance d'un obstacle fixe stable à ±15 cm en marchant |
| 2.2-2 Décision | TTC, trajectoire, même sens, véhicule garé, éléments longés, couloir sur le cap, pause, mémoire des lieux | 0 fausse alerte sur les 3 rejeux |
| 2.2-3 Restitution | Escalade vibration → voix → stop, 4 motifs, sons au rythme du TTC, phrases courtes, file unique | Écoute validée par Adrien |
| 2.2-4 Modes | Mode par défaut, modes de scène, foule, « Qu'y a-t-il devant ? », 3 crans | e2e des commandes |
| 2.2-5 Recette | Seuils réglés sur OnePlus, README, version publiée | v2.2 sur GitHub Pages |

Spécification détaillée et critères d'acceptation : FON-20 à FON-41, NFR-20 à NFR-24 dans le cahier des charges.

## Points ouverts

- Voix muette sur le OnePlus : correctif défensif en 2.2-0, **à vérifier sur le téléphone**. Hypothèses : (1) moteur de Chrome bloqué après une phrase coupée ou un passage en arrière-plan (plus rien ne sort) → si une phrase ne démarre pas en 3 s : `cancel()` puis nouvel essai avec le moteur par défaut, `resume()` si en pause ; (2) « Dis Oriane » : la voix partait alors que le micro n'était pas libéré → elle attend la fin réelle de l'écoute (400 ms au plus). Le journal note « 🔁 Voix bloquée… moteur relancé » ou « ⚠️ Voix muette » avec l'état du moteur, la voix et le mode mains libres.
- Vitesse réelle de la segmentation sur le OnePlus (WebGPU ou processeur) : lire la ligne d'état.
- Étalonnage des distances sur le terrain.
- Testeurs aveugles ou malvoyants à trouver (côté Adrien).
- Après la v2.2 : Kotlin Multiplatform + Android, démo ordinateur, lunettes AG18 (spécification confidentielle dans le Projet Claude, plan de validation A.8), iOS.

## Reprise du 20/11/2026 (Claude Code)

- Reprise vérifiée : 31 tests verts, cahier des charges § 15 relu (FON-20 à FON-41, NFR-20 à NFR-24).
- Constats complémentaires :
  - le lissage de `beta` dans `app.js` (0,7 / 0,3 à chaque événement, ≈ 60 Hz) ne dure qu'environ 50 ms, pas 300 ms : il ne filtre pas l'oscillation des pas ;
  - `VIB` n'a que 3 motifs, FON-32 en demande 4 (manque « double = obstacle sur le chemin ») ;
  - le script e2e est recréé avec Playwright (`tests/e2e/rejeu.e2e.mjs`).
- Choix pour le rejeu (FON-40) : enregistrer aussi la carte de segmentation, pour un rejeu identique à chaque passage, même sans WebGPU.
- Travail sur la branche `claude/tender-hawking-omq7tk`, à fusionner dans `main` pour publier sur GitHub Pages.

## Lot 2.2-0 Instruments — fait (20/11/2026, non publié)

- `js/sensors.js` et `js/pipeline.js` : capteurs (inclinaison, marche) et traitement d'une analyse sortis de `app.js`, **comportement v2.1 inchangé**, partagés par le direct et le rejeu.
- Journal détaillé : `AlertManager.update(...).events` décrit chaque décision (raison, vitesse de rapprochement par régression, TTC, sortie émise ou raison de la retenue). Affichage dans le journal, export CSV « alertes détaillées ». Les décisions ne changent pas.
- Compteur H1 (bêta, actif par défaut) dans la ligne d'état : dernière minute + moyenne par minute de marche (NFR-20).
- Enregistrement H3 (désactivé par défaut, Outils de test) : images 224 px (JPEG 0,6, facultatives), cartes de segmentation (RLE), inclinaison et paramètres caméra de chaque analyse, capteurs bruts en pleine précision, alertes du direct ; fichier `.json.gz` téléchargé localement, 10 min au plus, sans aucune clé (`safeSettings`).
- Rejeu : dans l'appli (analyse instantanée ou temps réel avec images, sons, voix) et en ligne de commande (`tools/rejeu.mjs`). Sans le modèle : les cartes repassent par la géométrie, les capteurs et les alertes actuels. Option `--inclinaison=enregistree` pour reproduire exactement le direct.
- Tests : 46 unitaires + 2 `todo` qui reproduisent les deux défauts du terrain sur des marches synthétiques (`tests/fixtures.js`) : voiture garée (±2° d'oscillation suffisent) et piéton au même pas (±5°). À faire passer au lot 2.2-2. E2E Playwright : `npm run e2e`.
- Correctifs au passage : `[hidden]` respecté partout en CSS (la case « zones reconnues » ne masquait pas le calque), cases à cocher qui rétrécissaient avec un long libellé.

**Pour clore le lot** : publier sur GitHub Pages (fusion dans `main`), puis Adrien enregistre 3 marches (voitures garées, suivre un piéton, longer une façade) et envoie les fichiers ; ils deviennent les rejeux de référence (FON-25, FON-28, FON-30, NFR-21).

## Pour lancer les tests

```bash
npm test
npm run e2e                          # Playwright + Chromium (lance son propre serveur sur le port 8765)
node tools/rejeu.mjs fichier.json.gz # rejeu d'une marche enregistrée
```
