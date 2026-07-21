from PIL import Image
import os

root = os.path.dirname(os.path.dirname(__file__))
img_path = os.path.join(root, 'assets', 'images', 'panorama.png')
backup_path = os.path.join(root, 'assets', 'images', 'panorama-orig-backup.png')

if not os.path.exists(img_path):
    print('panorama.png not found at', img_path)
    raise SystemExit(1)

img = Image.open(img_path).convert('RGB')
w, h = img.size
print('Original size:', w, 'x', h)

# target: 2:1 (width:height)
target_h = h
target_w = int(target_h * 2)

# backup original
if not os.path.exists(backup_path):
    img.save(backup_path, format='PNG')
    print('Backup saved to', backup_path)

if w >= target_w:
    # crop horizontally centered
    left = (w - target_w) // 2
    box = (left, 0, left + target_w, h)
    out = img.crop(box)
    print('Cropped horizontally to', target_w, 'x', target_h)
else:
    # need to enlarge width: resize proportionally then crop vertically to original height
    new_w = target_w
    scale = new_w / w
    new_h = int(h * scale)
    img2 = img.resize((new_w, new_h), Image.LANCZOS)
    # crop center vertically to target_h
    top = (new_h - target_h) // 2
    box = (0, top, new_w, top + target_h)
    out = img2.crop(box)
    print('Resized to', new_w, 'x', new_h, 'and cropped to', target_w, 'x', target_h)

out_path = img_path
out.save(out_path, format='PNG', optimize=True)
print('Saved 2:1 panorama to', out_path)
