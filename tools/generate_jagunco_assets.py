#!/usr/bin/env python3
"""Jagunco.io asset pipeline - reskins every sprite of the official client.

Reads editable configuration and pristine silhouettes from art/source/ and writes
the final PNGs to client/public/img/ (served at /img/* to the official client).

  art/source/palette.json            brand palette + HSV recolor rules (edit me)
  art/source/silhouettes/<group>/    pristine source sprites (bootstrapped once)

Silhouette provenance, in order:
  1. art/source/silhouettes/...          (already bootstrapped - canonical, editable)
  2. /mnt/agents/backup/jagunco-parity/reference/game-elements/public/img/...
  3. client/public/img/...               (only safe on the very first run, before
                                          this script overwrites them)

The recolor preserves each pixel's luminance and the sprite's alpha channel, so
silhouette, scale and hitbox stay identical - nothing renders invisible.

Usage: python3 tools/generate_jagunco_assets.py [--check-only]
"""

import hashlib
import json
import os
import shutil
import sys
from datetime import datetime, timezone

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART_SOURCE = os.path.join(ROOT, "art", "source")
SIL_DIR = os.path.join(ART_SOURCE, "silhouettes")
OUT_DIR = os.path.join(ROOT, "client", "public", "img")
REFERENCE = "/mnt/agents/backup/jagunco-parity/reference/game-elements/public/img"
MANIFEST = os.path.join(ROOT, "tools", "asset_manifest.json")

# ------------------------------------------------------------------ asset list
# Every file the official client bundle (client-official/source/index-*.js) or its
# stylesheet can request under /img/. Weapon ids 0-15 x variants "", _g, _d, _r, _e
# (normal/gold/diamond/ruby/emerald); projectiles arrow_1 + bullet_1; hats and
# accessories by store id (hats 11/14 also need _top/_p); animals by server src;
# UI icons (leaderboard crowns/skulls); resource icons (HUD); favicon; promo banner.

WEAPONS = ["hammer_1", "axe_1", "great_axe_1", "sword_1", "samurai_1", "spear_1",
           "bat_1", "dagger_1", "stick_1", "bow_1", "great_hammer_1", "shield_1",
           "crossbow_1", "crossbow_2", "grab_1", "musket_1"]
VARIANTS = ["", "_g", "_d", "_r", "_e"]
HAT_IDS = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18, 20, 21, 22, 23,
           26, 27, 28, 29, 30, 31, 32, 35, 36, 37, 38, 40, 42, 43, 44, 45, 46,
           48, 49, 50, 51, 52, 55, 56, 57, 58, 59, 60, 61]
TOP_SPRITE_HATS = [11, 14]  # also need hat_<id>_top.png and hat_<id>_p.png
ACCESSORY_IDS = list(range(1, 22))
ANIMALS = ["cow_1", "pig_1", "bull_1", "bull_2", "wolf_1", "wolf_2", "chicken_1",
           "boar_1", "yeti_1", "crab_1", "sheep_1", "enemy", "crate_1",
           "duck_1", "fish_1", "sid", "vince"]
ICONS = ["crown", "skull", "crown_gold", "crown_silver", "crown_bronze",
         "skull_crown_gold", "skull_crown_silver", "skull_crown_bronze"]
RESOURCES = ["food_ico", "wood_ico", "stone_ico", "gold_ico"]

SYNTHESIZED = {  # built by compose(), not copied from a silhouette
    "icons/crown_gold.png", "icons/crown_silver.png", "icons/crown_bronze.png",
    "icons/skull_crown_gold.png", "icons/skull_crown_silver.png",
    "icons/skull_crown_bronze.png", "favicon.png",
}


def required_assets():
    out = [f"weapons/{w}{v}.png" for w in WEAPONS for v in VARIANTS]
    out += ["weapons/arrow_1.png", "weapons/bullet_1.png"]
    out += [f"hats/hat_{i}.png" for i in HAT_IDS]
    for i in TOP_SPRITE_HATS:
        out += [f"hats/hat_{i}_top.png", f"hats/hat_{i}_p.png"]
    out += [f"accessories/access_{i}.png" for i in ACCESSORY_IDS]
    out += [f"animals/{a}.png" for a in ANIMALS]
    out += [f"icons/{i}.png" for i in ICONS]
    out += [f"resources/{r}.png" for r in RESOURCES]
    out += ["favicon.png", "promotion/banner_4.png"]
    return out


# -------------------------------------------------------------------- bootstrap
def bootstrap(cfg, log):
    """Fill art/source/silhouettes with pristine sprites (first run only)."""
    aliases = cfg.get("aliases", {})
    copied = {"reference": [], "client": []}
    for rel in required_assets():
        if rel in SYNTHESIZED:
            continue
        dst = os.path.join(SIL_DIR, rel)
        if os.path.exists(dst):
            continue
        src_rel = aliases.get(rel, rel)
        src = os.path.join(REFERENCE, src_rel)
        origin = "reference"
        if not os.path.exists(src):
            src = os.path.join(OUT_DIR, rel)
            origin = "client"
        if not os.path.exists(src):
            raise SystemExit(f"no silhouette source for {rel} (tried reference and client)")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        copied[origin].append(rel)
    for origin, files in copied.items():
        if files:
            log(f"bootstrap: copied {len(files)} silhouettes from {origin}")
    return copied


# --------------------------------------------------------------------- recolor
def recolor(img, cfg, special=None):
    """Luminance-preserving palette swap into the Jagunco sertanejo palette."""
    rules = cfg["recolor"]
    rgba = img.convert("RGBA")
    hsv = np.asarray(rgba.convert("HSV"), dtype=np.float32)
    h = hsv[..., 0] * (360.0 / 255.0)
    s = hsv[..., 1] / 255.0
    v = hsv[..., 2] / 255.0
    alpha = np.asarray(rgba)[..., 3]

    out_h = h.copy()
    out_s = s.copy()

    outline = rules["outline"]
    neutral = rules["neutral"]
    m_out = v <= outline["v_max"]
    m_neu = (~m_out) & (s <= neutral["s_max"])
    m_col = ~(m_out | m_neu)

    out_h[m_out] = outline["hue"]
    out_s[m_out] = outline["sat"]
    out_h[m_neu] = neutral["hue"]
    out_s[m_neu] = s[m_neu] * neutral["sat_scale"] + neutral["sat_add"]

    if special and "force_hue" in special:  # e.g. silver/bronze crowns
        out_h[m_col] = special["force_hue"]
        out_s[m_col] = special["force_sat"] * (0.65 + 0.35 * s[m_col])
    else:
        band_h = np.zeros_like(h)
        band_s = np.ones_like(s)
        for band in rules["bands"]:
            m = m_col & (h >= band["lo"]) & (h < band["hi"])
            span = max(band["hi"] - band["lo"], 1e-6)
            pos = np.clip((h - band["lo"]) / span, 0.15, 0.85)  # keep inner variety
            band_h[m] = band["hue"] + (pos[m] - 0.5) * 14.0
            band_s[m] = s[m] * band["sat_scale"]
        m_any = m_col & (band_h != 0)
        out_h[m_any] = band_h[m_any]
        out_s[m_any] = band_s[m_any]
        # hues below the first band start at 0 - catch hue==0 reds exactly
        m0 = m_col & ~m_any
        out_h[m0] = rules["bands"][0]["hue"]
        out_s[m0] = s[m0] * rules["bands"][0]["sat_scale"]

    lo, hi = rules["sat_clamp"]
    out_s = np.clip(out_s, 0, 1)
    m_any_s = alpha > 0
    out_s[m_any_s] = np.clip(out_s[m_any_s], lo, hi)
    gain = (special or {}).get("value_gain", rules.get("value_gain", 1.0))
    out_v = np.clip(v * gain, 0, 1)

    hsv_out = np.stack([out_h * (255.0 / 360.0), out_s * 255.0, out_v * 255.0], axis=-1)
    res = Image.fromarray(hsv_out.astype(np.uint8), "HSV").convert("RGBA")
    res.putalpha(Image.fromarray(alpha, "L"))
    return res


# -------------------------------------------------------------------- compose
def compose(rel, cfg, log):
    """Synthesized assets: leaderboard crowns, skull+crown combos, favicon."""
    special = cfg.get("special", {}).get(rel, {})
    if rel.startswith("icons/crown_"):
        base = Image.open(os.path.join(SIL_DIR, "icons", "crown.png"))
        return recolor(base, cfg, special)
    if rel.startswith("icons/skull_crown_"):
        skull = recolor(Image.open(os.path.join(SIL_DIR, "icons", "skull.png")), cfg)
        crown = recolor(Image.open(os.path.join(SIL_DIR, "icons", "crown.png")), cfg,
                        cfg.get("special", {}).get(special["crown"], {}))
        w = skull.width
        cw = int(w * 0.52)
        crown = crown.resize((cw, int(crown.height * cw / crown.width)), Image.LANCZOS)
        out = skull.copy()
        out.alpha_composite(crown, ((w - cw) // 2, int(w * 0.02)))
        return out
    if rel == "favicon.png":
        # Brand mark: the reskinned leather hat (hat_2) - the cangaceiro silhouette.
        hat = recolor(Image.open(os.path.join(SIL_DIR, "hats", "hat_2.png")), cfg)
        bbox = hat.getbbox()
        hat = hat.crop(bbox)
        size = 32  # matches the favicon the client ships today
        hat.thumbnail((size - 2, size - 2), Image.LANCZOS)
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.alpha_composite(hat, ((size - hat.width) // 2, (size - hat.height) // 2))
        return out
    raise SystemExit(f"no compose rule for {rel}")


# ------------------------------------------------------------------------ main
def main():
    check_only = "--check-only" in sys.argv
    log = print
    cfg = json.load(open(os.path.join(ART_SOURCE, "palette.json")))
    log(f"jagunco assets: {len(required_assets())} required")
    if not check_only:
        bootstrap(cfg, log)

    manifest = {"generated_at": datetime.now(timezone.utc).isoformat(),
                "palette": os.path.relpath(os.path.join(ART_SOURCE, "palette.json"), ROOT),
                "silhouettes": os.path.relpath(SIL_DIR, ROOT),
                "output": os.path.relpath(OUT_DIR, ROOT),
                "groups": {}, "files": []}
    problems = []

    for rel in required_assets():
        src = os.path.join(SIL_DIR, rel)
        dst = os.path.join(OUT_DIR, rel)
        if rel in SYNTHESIZED:
            if check_only:
                continue
            img = compose(rel, cfg, log)
            origin = "synthesized"
        else:
            if not os.path.exists(src):
                problems.append(f"MISSING SILHOUETTE: {rel}")
                continue
            img = recolor(Image.open(src), cfg)
            origin = "silhouette"
        alpha = np.asarray(img)[..., 3]
        opaque = float((alpha > 8).mean())
        if opaque < 0.005:
            problems.append(f"INVISIBLE (opaque {opaque:.4f}): {rel}")
        if not check_only:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            img.save(dst, optimize=True)
            digest = hashlib.sha1(open(dst, "rb").read()).hexdigest()[:12]
            group = rel.split("/")[0] if "/" in rel else "root"
            manifest["groups"][group] = manifest["groups"].get(group, 0) + 1
            manifest["files"].append({"path": rel, "size": list(img.size),
                                      "source": origin, "sha1": digest,
                                      "opaque_ratio": round(opaque, 4)})

    manifest["total"] = len(manifest["files"])
    if problems:
        for p in problems:
            log("ERROR:", p)
        raise SystemExit(f"{len(problems)} problem(s) - aborting")

    # ---------------------------------------------------------- hard coverage
    # Regression guards for gaps found in the old client/public/img tree:
    # every weapon must have all 5 variants (bow_1_d was missing), and every
    # leaderboard icon must exist (crown_gold/silver/bronze + skull_crown_*
    # were missing, rendering blank on the podium).
    if not check_only:
        for w in WEAPONS:
            for v in VARIANTS:
                rel = f"weapons/{w}{v}.png"
                if not os.path.exists(os.path.join(OUT_DIR, rel)):
                    raise SystemExit(f"coverage: missing weapon variant {rel}")
        for rel in [f"icons/{i}.png" for i in ICONS] + ["favicon.png"]:
            if not os.path.exists(os.path.join(OUT_DIR, rel)):
                raise SystemExit(f"coverage: missing UI icon {rel}")
        manifest["coverage"] = {
            "weapon_variants": f"{len(WEAPONS)} weapons x {len(VARIANTS)} variants - complete",
            "leaderboard_icons": ICONS,
            "hud_resource_icons": RESOURCES,
            "projectiles": ["weapons/arrow_1.png", "weapons/bullet_1.png"],
            "mobile_touch_controls": {
                "status": "DOM zones #touch-controls-left/right/fullscreen exist in page.html and "
                          "are styled by client-official/jagunco.css; the joystick itself comes from "
                          "a dynamic chunk (index-d71d2980.js, nipplejs) that is not part of the saved "
                          "page - see README notes / build integration.",
                "css_hooks": [".nipple", ".nipple .front", ".nipple .back",
                              "#touch-controls-left", "#touch-controls-right"],
            },
        }
        with open(MANIFEST, "w") as fh:
            json.dump(manifest, fh, indent=1)
        log(f"wrote {manifest['total']} assets -> {os.path.relpath(OUT_DIR, ROOT)}")
        log(f"manifest -> {os.path.relpath(MANIFEST, ROOT)}  groups: {manifest['groups']}")
    else:
        log("check-only: all silhouettes present and visible")


if __name__ == "__main__":
    main()
