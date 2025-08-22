import base64
from pathlib import Path

from openai import OpenAI


client = OpenAI()


def generate_arcanos_logo(output_path: str = "output/arcanos_logo.png") -> str:
    """
    Uses OpenAI SDK to request ARCANOS logo and save it as a PNG file.
    Returns the path to the saved file.
    """
    response = client.images.generate(
        model="gpt-image-1",
        prompt="Arasaka-inspired ARCANOS logo, cyberpunk corporate style, minimalist emblem.",
        size="1024x1024",
    )

    image_b64 = response.data[0].b64_json
    image_bytes = base64.b64decode(image_b64)

    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "wb") as f:
        f.write(image_bytes)

    return str(output_file)


if __name__ == "__main__":
    logo_path = generate_arcanos_logo()
    print(f"ARCANOS logo saved at: {logo_path}")
