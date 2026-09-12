"""
Trains a small heatmap-detector CNN on the auto-labeled dataset.json, then
exports it as a Keras SavedModel ready for tensorflowjs conversion.

Design notes:
- Single-channel output heatmap (16x16), one class ("a top"). Identity
  between the two tops isn't the model's job — exactly like the existing
  color tracker, the app's clustering + nearest-last-known-position logic
  (already in tracker.js) handles telling them apart frame to frame. This
  keeps the model simple and lets it reuse all of the app's existing
  downstream battle logic (ring-out, collisions, RPM, etc unchanged.
- Small input size (128x128) and a handful of conv+pool layers: this has to
  train on CPU, on well under 200 labeled frames, in a reasonable time.
- Augmentation (brightness/contrast jitter, horizontal flip) so the model
  has some chance of learning the tops' shape/texture rather than only the
  exact lighting of this one room — otherwise it would just be a slower,
  less transparent reimplementation of color thresholding.
"""
import json
import random
from pathlib import Path

import numpy as np
import tensorflow as tf
from PIL import Image

DATASET_DIR = Path("/tmp/claude-0/-home-user-Beyblade/3ba28899-90e8-5e3a-8f80-0cbd5dac6c8b/scratchpad/ai-dataset")
MODEL_OUT = DATASET_DIR / "model_savedmodel"

INPUT_SIZE = 128
HEATMAP_SIZE = 16
GAUSSIAN_SIGMA = 0.9  # in heatmap-grid units

random.seed(0)
np.random.seed(0)


def make_heatmap(points, orig_w, orig_h):
    hm = np.zeros((HEATMAP_SIZE, HEATMAP_SIZE), dtype=np.float32)
    yy, xx = np.mgrid[0:HEATMAP_SIZE, 0:HEATMAP_SIZE]
    for p in points:
        gx = p["x"] / orig_w * HEATMAP_SIZE
        gy = p["y"] / orig_h * HEATMAP_SIZE
        d2 = (xx - gx) ** 2 + (yy - gy) ** 2
        bump = np.exp(-d2 / (2 * GAUSSIAN_SIGMA ** 2))
        hm = np.maximum(hm, bump)
    return hm


def load_dataset():
    entries = json.loads((DATASET_DIR / "dataset.json").read_text())
    xs, ys = [], []
    for e in entries:
        img_path = DATASET_DIR / e["frame"]
        img = Image.open(img_path).convert("RGB")
        orig_w, orig_h = img.size
        img_small = img.resize((INPUT_SIZE, INPUT_SIZE))
        arr = np.asarray(img_small, dtype=np.float32) / 255.0
        hm = make_heatmap(e["points"], orig_w, orig_h)
        xs.append(arr)
        ys.append(hm)
    return np.stack(xs), np.stack(ys)[..., None]


def augment(x, y):
    # Random horizontal flip (heatmap flips with it).
    if random.random() < 0.5:
        x = x[:, ::-1, :]
        y = y[:, ::-1, :]
    # Random brightness/contrast jitter — helps generalize past this one
    # room's exact lighting, which is the point of trying this over plain
    # color thresholding.
    x = x * random.uniform(0.75, 1.25) + random.uniform(-0.08, 0.08)
    x = np.clip(x, 0.0, 1.0)
    return x, y


def build_model():
    inp = tf.keras.Input(shape=(INPUT_SIZE, INPUT_SIZE, 3))
    x = tf.keras.layers.Conv2D(16, 3, padding="same", activation="relu")(inp)
    x = tf.keras.layers.BatchNormalization()(x)
    x = tf.keras.layers.MaxPooling2D(2)(x)  # 64

    x = tf.keras.layers.Conv2D(32, 3, padding="same", activation="relu")(x)
    x = tf.keras.layers.BatchNormalization()(x)
    x = tf.keras.layers.MaxPooling2D(2)(x)  # 32

    x = tf.keras.layers.Conv2D(32, 3, padding="same", activation="relu")(x)
    x = tf.keras.layers.BatchNormalization()(x)
    x = tf.keras.layers.MaxPooling2D(2)(x)  # 16

    x = tf.keras.layers.Conv2D(24, 3, padding="same", activation="relu")(x)
    x = tf.keras.layers.Conv2D(16, 3, padding="same", activation="relu")(x)
    out = tf.keras.layers.Conv2D(1, 1, activation="sigmoid", name="heatmap")(x)

    model = tf.keras.Model(inp, out, name="top_detector")
    model.compile(optimizer=tf.keras.optimizers.Adam(1e-3), loss="mse")
    return model


def main():
    print("Loading dataset...")
    X, Y = load_dataset()
    print("dataset:", X.shape, Y.shape)

    n = len(X)
    idx = np.random.permutation(n)
    n_val = max(8, int(n * 0.15))
    val_idx, train_idx = idx[:n_val], idx[n_val:]

    X_train, Y_train = X[train_idx], Y[train_idx]
    X_val, Y_val = X[val_idx], Y[val_idx]
    print(f"train={len(X_train)} val={len(X_val)}")

    def gen():
        order = np.random.permutation(len(X_train))
        for i in order:
            yield augment(X_train[i], Y_train[i])

    def make_train_ds():
        ds = tf.data.Dataset.from_generator(
            gen,
            output_signature=(
                tf.TensorSpec(shape=(INPUT_SIZE, INPUT_SIZE, 3), dtype=tf.float32),
                tf.TensorSpec(shape=(HEATMAP_SIZE, HEATMAP_SIZE, 1), dtype=tf.float32),
            ),
        )
        return ds.batch(16).prefetch(tf.data.AUTOTUNE)

    model = build_model()
    model.summary()

    EPOCHS = 40
    best_val = float("inf")
    for epoch in range(EPOCHS):
        history = model.fit(make_train_ds(), epochs=1, verbose=0)
        val_loss = model.evaluate(X_val, Y_val, verbose=0)
        train_loss = history.history["loss"][0]
        if epoch % 5 == 0 or epoch == EPOCHS - 1:
            print(f"epoch {epoch:2d}  train_loss={train_loss:.5f}  val_loss={val_loss:.5f}")
        best_val = min(best_val, val_loss)

    print(f"Final val_loss={val_loss:.5f}  best_val_loss={best_val:.5f}")

    MODEL_OUT.parent.mkdir(parents=True, exist_ok=True)
    model.export(str(MODEL_OUT))
    print(f"Saved model to {MODEL_OUT}")


if __name__ == "__main__":
    main()
