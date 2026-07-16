# Art Pipeline — Model Recovery List

Bus-factor documentation: every model file the art pipeline depends on lives ONLY on
the owner's machine (`/home/akrij/ComfyUI/models/`). If that disk dies, this file is
the re-download map. Discovered from the live installation + `grep` of
`scripts/art/workflows/*.json` on 2026-07-16.

## Checkpoints (`ComfyUI/models/checkpoints/`)

| file | size | referenced by | source |
|---|---|---|---|
| `Juggernaut-XI-byRunDiffusion.safetensors` | 7.11 GB | portrait/fullbody/item/landscape-realistic, fullbody-realistic-tailor, portrait-sketch, realistic.json, sketch.json (realistic + sketch lanes) | CivitAI — "Juggernaut XI" by RunDiffusion |
| `JANKUTrainedChenkinNoobai_v777.safetensors` | 6.94 GB | portrait-anime, anime.json (anime lane) | source: UNVERIFIED — owner confirm (CivitAI-style filename; JANKU / NoobAI family) |
| `sdxlUnstableDiffusers_nihilmania.safetensors` | 6.94 GB | portrait-darkfantasy, dark-fantasy.json (painted dark-fantasy lane) | CivitAI — "SDXL Unstable Diffusers (YamerMIX)" by Yamer, Nihilmania version |

Present in the directory but NOT referenced by any pipeline workflow (no recovery
priority): `Illustrious-XL-v2.0.safetensors` (retired anime checkpoint, replaced by
JANKU in Chunk-6), `sd_xl_base_1.0.safetensors`, `wildcardxXLFusion_fusionOG.safetensors`.

## LoRAs (`ComfyUI/models/loras/`)

| file | size | referenced by | strengths in use | source |
|---|---|---|---|---|
| `add-detail-xl.safetensors` | 228 MB | portrait-darkfantasy (0.74), portrait-realistic (0.75), fullbody-realistic-tailor, dark-fantasy.json | 0.74–0.75 | CivitAI — "Detail Tweaker XL". Per-lane OPT-IN law: adopted per lane only after an owner side-by-side. |
| `hkstyleV5.safetensors` | 228 MB | portrait-darkfantasy (0.68/0.70), dark-fantasy.json | sm 0.68 / sc 0.70 | CivitAI — "XL Fantasy Knights" (hkstyle) |
| `DnD_Grainyboyz SDXL Lora.safetensors` | 85 MB | portrait-sketch (1.02/0.97), sketch.json | sm 1.02 / sc 0.97 | source: UNVERIFIED — owner confirm. Trigger words MANDATORY (see blocks/sketch.json). |

Other files in the LoRA directory are unrelated to this pipeline (video/WAN
experiments) and are not recovery-critical for art generation.

## IP-Adapter (`ComfyUI/models/ipadapter/`) — tailor dependency

| file | size | referenced by | source |
|---|---|---|---|
| `ip-adapter-plus-face_sdxl_vit-h.safetensors` | 848 MB | fullbody-realistic-tailor (IPAdapterUnifiedLoader) | HuggingFace — `h94/IP-Adapter`, `sdxl_models/` |

## CLIP Vision (`ComfyUI/models/clip_vision/`) — tailor dependency

| file | size | referenced by | source |
|---|---|---|---|
| `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | 2.53 GB | fullbody-realistic-tailor (loaded implicitly by IPAdapterUnifiedLoader) | HuggingFace — `laion/CLIP-ViT-H-14-laion2B-s32B-b79K` (also mirrored as the image encoder inside `h94/IP-Adapter`) |

## Runtime notes (hard-won — do not relearn)

- ComfyUI serves on **http://127.0.0.1:8188** (`~/ComfyUI`, `venv/bin/python main.py`).
- **`--novram` is required on this 8 GB GPU** (RTX 4060) for the heavier stacks; the
  card has a 3-freeze history (see generate.mjs GPU-safety rules: batch aborts under
  1 GB free VRAM, ComfyUI never idles after a batch).
- The tailor workflow's IP-Adapter uses the **Unified Loader with preset
  "PLUS FACE (portraits)"** — the preset must match the installed
  `ip-adapter-plus-face_sdxl_vit-h` file, and the CLIP-ViT-H vision model must be
  present or the Unified Loader errors on load.
- Custom nodes in use: ComfyUI-GGUF, ComfyUI-Manager, websocket_image_save
  (`~/ComfyUI/custom_nodes/`).
