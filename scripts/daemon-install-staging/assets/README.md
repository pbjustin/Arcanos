# ARCANOS Assets

This directory contains assets for the ARCANOS application:

- `icon.ico` - Windows executable icon (256x256, .ico format)
- `icon.png` - Windows Terminal profile icon (256x256, .png format)

## Creating Icons

### From an Image:

1. Create a 256x256 PNG image with your desired icon
2. Convert to .ico using an online tool or ImageMagick:
   ```bash
   magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
   ```

### Default Icon:

If no custom icon is provided, ARCANOS will use the Windows default terminal icon.

## Recommendations:

- Use simple, recognizable designs that work at small sizes
- Prefer bold shapes and high contrast
- Test at 16x16 to ensure clarity
- Consider using a neon/cyberpunk aesthetic to match ARCANOS theme
