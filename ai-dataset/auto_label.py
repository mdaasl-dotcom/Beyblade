"""
Weak-supervision auto-labeler for the Bey XR / Spin Battle Tracker AI dataset.

Rather than relying on color (which is exactly what the existing tracker
already struggles with — the stadium's green rim and the wood/carpet
background can confound a naive hue match), this finds tops by MOTION:
frame-to-frame pixel differences, restricted to the stadium's interior
region. A spinning top is one of the most motion-distinctive things in an
otherwise mostly-static scene, so this gives much cleaner weak labels than
color thresholding would across 200 frames of varied footage.

Output: dataset.json — a list of {frame, points: [{x,y}, ...]} in ORIGINAL
frame pixel coordinates (up to 2 points per frame, for up to 2 detected
blobs of motion).
"""
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image

FRAMES_DIR = Path("/tmp/claude-0/-home-user-Beyblade/3ba28899-90e8-5e3a-8f80-0cbd5dac6c8b/scratchpad/ai-dataset/frames")
OUT_PATH = Path("/tmp/claude-0/-home-user-Beyblade/3ba28899-90e8-5e3a-8f80-0cbd5dac6c8b/scratchpad/ai-dataset/dataset.json")

# Stadium interior occupies roughly the left half of the frame in this
# footage (native 1280x720); the right half is the plain white paper
# backdrop. Restricting the search region avoids ever picking up the
# person's moving hand/arm during launches, which also happens on the left
# but higher up / more diffusely than the tightly-orbiting top itself —
# handled below via blob compactness instead of just this crop.
SEARCH_BOX = (0, 0, 700, 720)  # x0, y0, x1, y1 in original frame coords
DOWNSCALE = 4  # process at 1/4 resolution for speed; upscale coords back after

FPS = 8  # matches the fps= used when extracting frames — see re-extract commands
LAUNCH_SKIP_SECONDS = 3.0  # skip the launch phase: hands/launchers also move fast
                           # enough to get falsely detected as "a top" by pure motion

DIFF_THRESHOLD = 18       # per-channel abs diff to count a pixel as "changed"
MIN_BLOB_PIXELS = 8       # at downscaled resolution
MAX_BLOB_PIXELS = 900     # rejects large diffuse regions like a moving arm/hand
MERGE_RADIUS = 10         # downscaled-px; matches tracker.js's clustering idea


def load_gray_crop(path):
    img = Image.open(path).convert("RGB")
    x0, y0, x1, y1 = SEARCH_BOX
    crop = img.crop((x0, y0, x1, y1))
    w, h = crop.size
    small = crop.resize((w // DOWNSCALE, h // DOWNSCALE))
    arr = np.asarray(small).astype(np.int16)
    return arr  # (h, w, 3)


def cluster_points(points, radius):
    """Greedy single-linkage-ish clustering, same idea as tracker.js."""
    clusters = []  # list of [sum_x, sum_y, count]
    for (x, y) in points:
        placed = False
        for c in clusters:
            cx, cy = c[0] / c[2], c[1] / c[2]
            if (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2:
                c[0] += x
                c[1] += y
                c[2] += 1
                placed = True
                break
        if not placed:
            clusters.append([x, y, 1])
    return [(c[0] / c[2], c[1] / c[2], c[2]) for c in clusters]


STALE_AFTER_FRAMES = 3  # only prevents duplicate-track spawning now — labels always require stale==0
MATCH_RADIUS = 14        # downscaled-px: how close a new blob must be to "confirm" a tracked point


def main():
    clips = sorted(d for d in FRAMES_DIR.iterdir() if d.is_dir())
    dataset = []
    stats = {"frames": 0, "labeled_2": 0, "labeled_1": 0, "labeled_0": 0}

    for clip_dir in clips:
        frame_paths = sorted(clip_dir.glob("*.png"))
        prev_arr = None
        # Per-clip persistent tracks: each is {x, y, stale} in downscaled coords.
        # A settled/stationary top produces no motion diff, so without this it
        # would silently disappear from the labels the moment it stops —
        # exactly the frames we most need for stamina-out training data.
        tracks = []

        for frame_idx, fp in enumerate(frame_paths):
            arr = load_gray_crop(fp)
            stats["frames"] += 1
            past_launch = (frame_idx / FPS) >= LAUNCH_SKIP_SECONDS
            if prev_arr is not None and prev_arr.shape == arr.shape:
                diff = np.abs(arr - prev_arr).sum(axis=2)  # (h, w)
                changed = diff > (DIFF_THRESHOLD * 3)
                ys, xs = np.nonzero(changed)
                pts = list(zip(xs.tolist(), ys.tolist()))
                clusters = cluster_points(pts, MERGE_RADIUS)
                good = [c for c in clusters if MIN_BLOB_PIXELS <= c[2] <= MAX_BLOB_PIXELS]
                good.sort(key=lambda c: -c[2])

                # Match fresh motion blobs against existing tracks by proximity;
                # update matched tracks, start new ones for unmatched blobs.
                unmatched_blobs = list(good)
                for track in tracks:
                    best_i, best_d = None, MATCH_RADIUS
                    for i, (cx, cy, count) in enumerate(unmatched_blobs):
                        d = ((cx - track["x"]) ** 2 + (cy - track["y"]) ** 2) ** 0.5
                        if d < best_d:
                            best_i, best_d = i, d
                    if best_i is not None:
                        cx, cy, _ = unmatched_blobs.pop(best_i)
                        track["x"], track["y"] = cx, cy
                        track["stale"] = 0
                    else:
                        track["stale"] += 1

                tracks = [t for t in tracks if t["stale"] <= STALE_AFTER_FRAMES]

                # Any strong unmatched blob becomes a new track (e.g. a top
                # freshly launched, or the very first frames of the clip).
                unmatched_blobs.sort(key=lambda c: -c[2])
                for (cx, cy, count) in unmatched_blobs:
                    if len(tracks) >= 2:
                        break
                    tracks.append({"x": cx, "y": cy, "stale": 0})

                # Only emit points for tracks CONFIRMED this exact frame
                # (stale == 0) as training labels. Stale tracks are kept
                # around internally for a few frames purely so a
                # momentarily-occluded/motion-blurred-below-threshold top
                # doesn't spawn a duplicate new track the instant it's
                # re-detected — but their carried-forward position is never
                # itself trustworthy enough to train on; letting it "fill
                # in" empty frames is exactly what let ghost tracks drift
                # onto noise and sit there for dozens of frames earlier.
                points = []
                for t in tracks:
                    if t["stale"] > 0:
                        continue
                    orig_x = t["x"] * DOWNSCALE + SEARCH_BOX[0]
                    orig_y = t["y"] * DOWNSCALE + SEARCH_BOX[1]
                    points.append({"x": round(orig_x, 1), "y": round(orig_y, 1)})
                    if len(points) >= 2:
                        break

                # Tracking state (tracks/prev_arr) still updates every frame
                # above regardless — only whether we TRUST this frame enough
                # to add it as a training example is gated on being past the
                # launch phase, where a hand/launcher can get mistaken for a
                # top by pure motion.
                if past_launch:
                    dataset.append({
                        "frame": str(fp.relative_to(FRAMES_DIR.parent)),
                        "points": points,
                    })
                    stats[f"labeled_{len(points)}"] = stats.get(f"labeled_{len(points)}", 0) + 1

            prev_arr = arr

    OUT_PATH.write_text(json.dumps(dataset, indent=1))
    print(f"Wrote {len(dataset)} labeled frames to {OUT_PATH}")
    print("Stats:", stats)


if __name__ == "__main__":
    main()
