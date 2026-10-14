# SEM Grid Calibrator

## Source snapshot from branch zwj

This source-only snapshot includes the application, batch analysis, compensation and unit
conversion code, repeated-block specimen reference, parameter-chart UI,
regression tests, and `TECHNICAL.md`. Generated results, reports and private
analysis-data snapshots are not included. The original repository's bundled
07 TIFF is also excluded. Upload your own image before extraction, or provide
its path in the SEM_GRID_IMAGE environment variable.

Run `npm install` at the repository root, then `npm run start:distortField`.
Other TIFFs can be uploaded in the single-image or batch sections. Analysis
does not require the two locally collected acquisition folders. The circular
hole ROI experiments are not part of this square-grid application snapshot.

Parameter charts load `public/parameter-analysis-data.json`, which is generated
locally and deliberately excluded from Git. The chart UI is included, but a
fresh checkout has no private batch dataset. `build-dependency-report.js`
requires the local paired-mode cache and pilot comparison results described
below; it is not an automatic part of server startup. Historical caches must
be rebuilt with the same algorithm version before comparing batches.

Core regression checks (from `apps/distortField`):

```sh
node test-grid.js
node test-cluster-lattice.js
node test-full-compensation.js
node test-units-and-geometry.js
node test-canvas-redraw.js
node test-preview-loading.js
node test-tiff-compatibility.js
```

Full compensation preserves the detected repeating block intervals rather
than forcing every specimen gap to become equal. A repeated pattern is only
accepted with sufficient coverage and at least three repeated observations
per phase. This relies on the confirmed specimen design, not an independent
absolute calibration. See `TECHNICAL.md` for the model and its limitations.

A local GUI for extracting and robustly fitting horizontal and vertical
straight centerlines through the bright squares of an SEM grid calibration
sample. Each line is robustly regressed from all valid square centers it crosses.

## Run

From the repository root:

```powershell
npm install
npm run start:distortField
```

Then open <http://localhost:4173>, select and upload your own TIFF, and click
**Extract grid lines**. The fitted lines can be exported as JSON or as an overlay
PNG. **Load image** and restoring the default require a locally provided sample;
no TIFF is included in this source snapshot.

Use the mouse wheel to zoom around the cursor, drag the image to pan, and
double-click the viewer (or click **Fit view**) to reset the view.

After line extraction, **Compute distortion field** compares every measured
square center with the best-fitting ideal square lattice. The heatmap shows
displacement magnitude in pixels and the white arrows show displacement
direction (magnified for visibility). Numeric mean, RMS, 95th-percentile, and
maximum displacement values are reported in the side panel.

The measured displacement vectors are robustly fitted with cubic 2D polynomial
surfaces before display. This suppresses individual damaged-square detections
and produces a continuous physical distortion field rather than a blocky map.

Enable **Centers** to draw a large magenta dot with a white outline at every
measured square center used by the line regressions and distortion calculation.

Squares are detected efficiently on a reduced-resolution, locally background-
corrected image using Otsu segmentation and connected-component filtering.
Every accepted center is then refined on the original-resolution pixels. The
refinement uses the median midpoint of opposing component boundaries instead of
a plain area centroid, making it less sensitive to missing corners, dirt, and
brightness gradients. Rejected components do not enter the regressions.

Each row and column is independently fitted with a robust Theil-Sen initialized
straight-line regression. This lets the observed SEM distortion change line
orientation instead of forcing all detected lines to remain perpendicular.

Enable **Square pixels** to overlay every accepted component pixel in translucent
turquoise. Use it together with **Centers** to see how the segmented component's
shape determines the magenta centroid.

Click a fitted horizontal or vertical line to exclude that complete row or
column. Excluded lines and centers are hidden, and the ideal lattice plus
distortion field are recomputed without their samples. **Restore excluded
lines** clears the manual exclusions.

The distortion field is also decomposed into a Brown-Conrady radial model
(`k1`, `k2`, `k3`), tangential/decentering terms (`p1`, `p2`), a linear affine
scale/shear component, and the remaining residual field. The component selector
plots each contribution independently. Pixel values are converted to nanometers
using the displayed 63.5 µm horizontal FOV (15.50 nm/px for a 4096 px width).
The nonlinear view removes the affine scale/shear term so optical or scan-field
curvature is not hidden by the usually much larger linear calibration error.

For formulas, implementation details, quality flags, and batch usage, see
[`TECHNICAL.md`](TECHNICAL.md).

## Square-grid rectification

After extracting the grid, the results panel shows the average tilt of rows
from horizontal, the tilt of columns from vertical, and the angle between
them. **Rectified preview** switches the viewer between the original scan and
the corrected scan, with the overlays transformed along with the image.
**Export rectified PNG** applies the same area-preserving affine transform to
the specimen scan, aligning the average row and column directions with the
image axes and making their average spacing equal. The SEM footer is omitted.
The raw image and raw distortion measurements are not replaced. A single
affine transform does not remove local nonlinear distortion.

The same operation is available for a TIFF file on the command line:

```sh
node apps/distortField/rectify-image.js input.tif output.png
```

The output path must be new. The command prints the measured angles and the
image quality warnings. Batch CSV exports include `rowTiltDeg`,
`columnTiltDeg`, `includedAngleDeg`, `orthogonalityErrorDeg`, and
`rectifiedPitchPx`.

The web UI also accepts multiple TIFF files in the **Batch analysis** section.
Uploads are processed sequentially and can be exported as compact CSV or JSON
summaries. Use `npm run batch` when full per-center and per-grid-vector JSON is
required for later distortion-field reconstruction.

### Orthogonality pilot and parameter dependencies (2026-10-09)

The viewer now supports px, nm, µm, percent of original scan width, and
percent of ideal grid pitch. Enter the horizontal FOV in µm before extraction
to use the image's actual scale. Without it, the physical scale is explicitly
marked as an estimate from magnification; unknown magnification has no nm value.
Batch CSV includes converted P95 values and the physical scale source.

```bash
node apps/distortField/test-units-and-geometry.js
node apps/distortField/test-orthogonal-pair.js
node apps/distortField/build-dependency-report.js
node apps/distortField/rectify-image.js input.tif output.png --angle-only
```

The pilot uses first-batch 26 and second-batch 29 (10 kV / 2000× / 8K).
It writes an angle-only corrected image, a fixed-center counterfactual,
a redetection check, and CSV/JSON into `results/2026-10-09-orthogonal-test`.
The dependency report is also accessible from the batch section of the viewer.
It uses the 2026-10-08 reanalysis cache; the core fit is unchanged by unit conversion.

The legacy pilot commands require your own local inputs. Run
`node analyze-mode-comparison.js batches.json` with two records containing
`batch`, `csv` and `dir`. Run
`node test-orthogonal-pair.js output-directory pair.json` with two records
containing `batch`, `file`, `fov` (µm), and optional `wd` (mm).
Input paths resolve relative to the JSON configuration file, not to a
contributor's workstation. No acquisition paths or input files are bundled.

To supply WD, actual FOV and minutes after calibration, fill the generated
`acquisition-metadata-template.json`, save it under a new name, then run:

```bash
node apps/distortField/build-dependency-report.js output-directory metadata.json
```

Use the pilot output directory (containing `comparison.json`) as the first
argument. Missing metadata stays missing, not zero. Trend lines connect measured
levels within matched recorded acquisition settings. They are associations,
not causal contributions. Batch dates are not used as elapsed calibration time.
