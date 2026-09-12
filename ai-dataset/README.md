# AI detector training pipeline

How the model in `model/` (loaded by `src/aiDetector.js` for "Try AI
Detection (Beta)") was produced, and how to retrain it with more footage.

## Pipeline

1. **Record footage** of your actual tops battling in your actual stadium —
   short clips (15-30s), varied lighting/angles, real launches and full
   spin-downs. The model only knows what it's seen, so more varied footage
   makes it generalize better.

2. **Extract frames**: `ffmpeg -i clip.mp4 -vf "fps=8" frames/clipNN/f%03d.png`
   (8fps was the sweet spot found here — fast enough to catch real motion,
   slow enough that the motion-diff signal per frame pair is reliable).

3. **Auto-label**: `python3 auto_label.py` — finds the tops by MOTION
   (frame-to-frame pixel diffing) rather than color, since color is exactly
   what the existing tracker already struggles with in some lighting. Keeps
   a short per-clip position "track" per top so a top that's gone
   momentarily still (no motion) isn't lost from the labels, but only ever
   emits a label for a track *reconfirmed by real motion this exact frame*
   — earlier versions that let stale/carried-forward positions stand as
   labels let the labeler drift onto noise over dozens of frames. Also
   skips the first `LAUNCH_SKIP_SECONDS` of each clip, since a
   hand/launcher in motion can otherwise get mistaken for a top.

   **Always spot-check the output** (draw the points back onto sample
   frames and look) before training — see the commit history for the
   iterations this went through and what each fixed.

4. **Train**: `python3 train.py` — a small CNN (~25K params, single-channel
   16x16 heatmap output) trained on CPU in well under a minute given how
   small this dataset is. Includes brightness/contrast jitter + horizontal
   flip augmentation so it has some chance of learning the tops'
   shape/texture rather than only this one room's exact lighting.

5. **Convert for the browser**:
   ```
   python3 -m tensorflowjs.converters.converter \
     --input_format=tf_saved_model --output_format=tfjs_graph_model \
     --signature_name=serve --saved_model_tags=serve \
     model_savedmodel web_model
   ```
   Copy `web_model/*` into the app's `model/` directory.

## Honest status (as of the first training run)

Trained on 266 auto-labeled frames from 2 clips, same room/lighting/camera
position both times. Qualitative spot-checks show it genuinely localizing
both tops in most frames — including the stationary one, which pure color
matching in this same setup struggled with — but it's not flawless: it
sometimes only detects one top in a frame, and occasionally reports an
extra false point. It has **not** been tested against lighting, background,
or tops different from what these two clips show, so don't assume it
generalizes there yet.

**To improve it**: send more clips (different lighting/background/angles),
rerun steps 2-5. The pipeline supports adding more clip folders under
`frames/` without touching existing ones. Raw video files, extracted PNG
frames, and the intermediate `model_savedmodel/` and `web_model/` build
directories aren't checked into this repo (large, regenerable) — only these
two scripts and this README are, plus the final small `model/` the app
actually loads.
