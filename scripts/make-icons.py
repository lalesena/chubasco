#!/usr/bin/env python3
"""Genera el icono de la app (png/ico/icns) y los iconos de la bandeja.

Uso: python3 scripts/make-icons.py   (requiere Pillow)
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, 'build')
TRAY = os.path.join(ROOT, 'assets', 'tray')
os.makedirs(BUILD, exist_ok=True)
os.makedirs(TRAY, exist_ok=True)

TEAL = (0, 163, 224)      # 20 dBZ en la paleta del radar
ICE = (136, 221, 238)     # 15 dBZ
AMBER = (255, 170, 0)     # 40 dBZ
NAVY_TOP = (16, 58, 86)
NAVY_BOTTOM = (8, 28, 44)


def drop_polygon(cx, cy, r, steps=160):
    """Gota: círculo de radio r con punta hacia arriba a 2.15 r del centro."""
    tip = (cx, cy - r * 2.15)
    # Ángulos de tangencia desde la punta al círculo.
    d = r * 2.15
    a = math.asin(r / d)
    pts = [tip]
    start = -math.pi / 2 + (math.pi / 2 - a)  # punto de tangencia derecho
    end = start + (math.pi + 2 * a)
    for i in range(steps + 1):
        t = start + (end - start) * i / steps
        pts.append((cx + r * math.cos(t), cy + r * math.sin(t)))
    return pts


def app_icon(size=1024):
    s = 4  # supermuestreo
    W = size * s
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))

    # Sombra del cuadrado redondeado
    margin = int(W * 0.098)
    box = (margin, margin, W - margin, W - margin)
    radius = int((box[2] - box[0]) * 0.225)
    shadow = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (box[0], box[1] + int(W * 0.012), box[2], box[3] + int(W * 0.012)), radius, fill=(0, 0, 0, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(W * 0.012))
    img.alpha_composite(shadow)

    # Fondo con degradado vertical
    grad = Image.new('RGBA', (W, W))
    gd = ImageDraw.Draw(grad)
    for y in range(W):
        f = y / W
        c = tuple(int(NAVY_TOP[i] + (NAVY_BOTTOM[i] - NAVY_TOP[i]) * f) for i in range(3))
        gd.line([(0, y), (W, y)], fill=c + (255,))
    mask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius, fill=255)
    bg = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    bg.paste(grad, (0, 0), mask)
    img.alpha_composite(bg)

    layer = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = W * 0.5, W * 0.6

    # Anillos de radar
    for i, rr in enumerate([0.16, 0.25, 0.34]):
        R = W * rr
        d.ellipse((cx - R, cy - R, cx + R, cy + R), outline=TEAL + (70 - i * 15,), width=int(W * 0.006))

    # Barrido del radar (cuña) hacia arriba a la derecha
    sweep = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sweep)
    R = W * 0.34
    for k in range(40):
        a0 = -90 + k * 1.5
        alpha = int(90 * (1 - k / 40))
        sd.pieslice((cx - R, cy - R, cx + R, cy + R), a0, a0 + 1.6, fill=TEAL + (alpha,))
    sweep_mask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(sweep_mask).rounded_rectangle(box, radius, fill=255)
    clipped = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    clipped.paste(sweep, (0, 0), sweep_mask)
    layer.alpha_composite(clipped)

    # Eco ámbar (tormenta) en el anillo exterior
    ex, ey, er = cx + W * 0.215, cy - W * 0.2, W * 0.045
    d.ellipse((ex - er, ey - er, ex + er, ey + er), fill=AMBER + (255,))
    d.ellipse((ex - er * 2, ey - er * 2, ex + er * 2, ey + er * 2), outline=AMBER + (90,), width=int(W * 0.006))

    clipped_layer = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    clipped_layer.paste(layer, (0, 0), sweep_mask)
    img.alpha_composite(clipped_layer)

    # Gota principal con degradado
    dr = W * 0.15
    dcx, dcy = cx - W * 0.02, cy + W * 0.04
    poly = drop_polygon(dcx, dcy, dr)
    dmask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(dmask).polygon(poly, fill=255)
    dgrad = Image.new('RGBA', (W, W))
    dg = ImageDraw.Draw(dgrad)
    top = dcy - dr * 2.15
    for y in range(int(top), int(dcy + dr) + 1):
        f = max(0, min(1, (y - top) / (dr * 3.15)))
        c = tuple(int(ICE[i] + (TEAL[i] - ICE[i]) * f) for i in range(3))
        dg.line([(0, y), (W, y)], fill=c + (255,))
    drop = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    drop.paste(dgrad, (0, 0), dmask)
    # Sombra suave de la gota
    sh = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x + W * 0.008, y + W * 0.014) for x, y in poly], fill=(0, 10, 20, 120))
    sh = sh.filter(ImageFilter.GaussianBlur(W * 0.01))
    img.alpha_composite(sh)
    img.alpha_composite(drop)
    # Brillo
    hl = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hr = dr * 0.55
    hd.arc((dcx - hr - dr * 0.12, dcy - hr - dr * 0.05, dcx + hr - dr * 0.12, dcy + hr - dr * 0.05), 150, 235,
           fill=(255, 255, 255, 170), width=int(W * 0.016))
    img.alpha_composite(hl)

    return img.resize((size, size), Image.LANCZOS)


def tray_icon(state, size, template):
    s = 8
    W = size * s
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = W * 0.27
    cx, cy = W * 0.5, W * 0.66
    poly = drop_polygon(cx, cy, r)
    lw = max(int(W * 0.1), s)

    if template:
        ink = (0, 0, 0, 255)
        fill_full = ink
        fill_half = ink
        outline = ink
    else:
        colors = {
            'clear': (150, 170, 190), 'nearby': TEAL, 'approaching': TEAL, 'imminent': AMBER,
            'raining': TEAL, 'snoozed': (150, 170, 190), 'unknown': (150, 170, 190)
        }
        c = colors.get(state, (150, 170, 190))
        outline = c + (255,)
        fill_full = c + (255,)
        fill_half = c + (255,)

    if state == 'raining':
        d.polygon(poly, fill=fill_full)
        d.line(poly + [poly[0]], fill=outline, width=lw, joint='curve')
    elif state in ('approaching', 'imminent', 'nearby'):
        # Mitad inferior rellena
        mask = Image.new('L', (W, W), 0)
        ImageDraw.Draw(mask).polygon(poly, fill=255)
        half = Image.new('L', (W, W), 0)
        level = cy - r * (0.1 if state == 'nearby' else 0.45 if state == 'approaching' else 0.9)
        ImageDraw.Draw(half).rectangle((0, level, W, W), fill=255)
        from PIL import ImageChops
        m = ImageChops.multiply(mask, half)
        solid = Image.new('RGBA', (W, W), fill_half)
        img.paste(solid, (0, 0), m)
        d.line(poly + [poly[0]], fill=outline, width=lw, joint='curve')
    else:
        d.line(poly + [poly[0]], fill=outline, width=lw, joint='curve')
        if state == 'snoozed':
            d.line((W * 0.18, W * 0.2, W * 0.82, W * 0.92), fill=outline, width=lw)
        if state == 'unknown':
            rr = W * 0.07
            d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=outline)
    return img.resize((size, size), Image.LANCZOS)


def main():
    icon = app_icon(1024)
    icon.save(os.path.join(BUILD, 'icon.png'))
    icon.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, 'assets', 'icon-512.png'))
    icon.save(os.path.join(BUILD, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    try:
        icon.save(os.path.join(BUILD, 'icon.icns'))
    except Exception as e:  # noqa
        print('icns no generado:', e)

    states = ['clear', 'nearby', 'approaching', 'imminent', 'raining', 'snoozed', 'unknown']
    for st in states:
        for scale, sz in ((1, 18), (2, 36)):
            suffix = '' if scale == 1 else '@2x'
            tray_icon(st, sz, True).save(os.path.join(TRAY, f'{st}Template{suffix}.png'))
        for scale, sz in ((1, 16), (2, 32)):
            suffix = '' if scale == 1 else '@2x'
            tray_icon(st, sz, False).save(os.path.join(TRAY, f'{st}{suffix}.png'))
    print('ok')


if __name__ == '__main__':
    main()
