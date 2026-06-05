from pathlib import Path
import subprocess
import json
import gradio as gr


def has_alpha(input_path):
    try:
        probe_cmd = [
            "ffprobe",
            "-v", "error",
            "-show_streams",
            "-of", "json",
            str(input_path)
        ]

        result = subprocess.run(
            probe_cmd,
            capture_output=True,
            text=True,
            check=True
        )

        data = json.loads(result.stdout)

        alpha_formats = {
            "yuva420p",
            "yuva422p",
            "yuva444p",
            "yuva444p10le",
            "yuva444p12le",
            "rgba",
            "bgra",
            "argb",
            "abgr"
        }

        for stream in data.get("streams", []):
            pix_fmt = stream.get("pix_fmt", "")

            if pix_fmt in alpha_formats:
                return True

            tags = stream.get("tags", {})
            if tags.get("alpha_mode") == "1":
                return True

    except Exception:
        pass

    return False


def convert_files(
        files,
        output_format,
        preset,
        crf,
        keep_audio,
        output_dir):  # Added output_dir argument

    log = []

    cpu_used_map = {
        "Fast": "6",
        "Balanced": "4",
        "High Quality": "2"
    }

    cpu_used = cpu_used_map[preset]

    # Validate and handle custom output directory
    custom_dir_path = None
    if output_dir and output_dir.strip():
        try:
            custom_dir_path = Path(output_dir.strip())
            custom_dir_path.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            return f"✗ Error creating target directory: {str(e)}"

    for file in files:

        input_path = Path(file)
        source_has_alpha = has_alpha(input_path)

        # -------------------
        # OUTPUT EXTENSION
        # -------------------

        if output_format == "WebM (VP9)":
            extension = ".webm"
            suffix = "_vp9"

        elif output_format == "MP4 (H264)":
            extension = ".mp4"
            suffix = "_h264"

        elif output_format == "GIF":
            extension = ".gif"
            suffix = "_gif"

        else:
            extension = ".mov"
            suffix = "_prores"

        # Determine target directory
        target_directory = custom_dir_path if custom_dir_path else input_path.parent

        output_path = (
            target_directory /
            f"{input_path.stem}{suffix}{extension}"
        )

        cmd = [
            "ffmpeg",
            "-y",
            "-i", str(input_path)
        ]

        # ------------------------------------------------
        # WEBM VP9
        # ------------------------------------------------

        if output_format == "WebM (VP9)":

            cmd += [
                "-c:v", "libvpx-vp9",
                "-row-mt", "1",
                "-threads", "16",
                "-crf", str(crf),
                "-b:v", "0",
                "-deadline", "good",
                "-cpu-used", cpu_used
            ]

            if source_has_alpha:

                cmd += [
                    "-pix_fmt", "yuva420p",
                    "-auto-alt-ref", "0"
                ]

            else:

                cmd += [
                    "-pix_fmt", "yuv420p"
                ]

        # ------------------------------------------------
        # MP4
        # ------------------------------------------------

        elif output_format == "MP4 (H264)":

            cmd += [
                "-c:v", "libx264",
                "-crf", str(crf),
                "-pix_fmt", "yuv420p"
            ]

        # ------------------------------------------------
        # GIF
        # ------------------------------------------------

        elif output_format == "GIF":

            cmd += [
                "-vf", "fps=15"
            ]

        # ------------------------------------------------
        # PRORES 4444
        # ------------------------------------------------

        elif output_format == "MOV (ProRes 4444)":

            cmd += [
                "-c:v", "prores_ks",
                "-profile:v", "4444"
            ]

            if source_has_alpha:

                cmd += [
                    "-pix_fmt", "yuva444p10le"
                ]

            else:

                cmd += [
                    "-pix_fmt", "yuv422p10le"
                ]

        # ------------------------------------------------
        # AUDIO
        # ------------------------------------------------

        if keep_audio:

            if output_format == "WebM (VP9)":
                cmd += ["-c:a", "libopus"]

            elif output_format == "MP4 (H264)":
                cmd += ["-c:a", "aac"]

            elif output_format == "MOV (ProRes 4444)":
                cmd += ["-c:a", "pcm_s16le"]

        else:

            cmd += ["-an"]

        cmd.append(str(output_path))

        try:

            subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True
            )

            message = (
                f"✓ {input_path.name}\n"
                f"Alpha detected: {source_has_alpha}\n"
                f"Exported:\n{output_path}"
            )

            if (
                source_has_alpha and
                output_format == "MP4 (H264)"
            ):
                message += "\nWARNING: MP4 does not support transparency."

            log.append(message)

        except subprocess.CalledProcessError as e:

            log.append(
                f"✗ Failed: {input_path.name}\n\n{e.stderr}"
            )

    return "\n\n".join(log)


with gr.Blocks() as demo:

    gr.Markdown("# Universal Video Converter")

    files = gr.File(
        label="Drop MOV / MP4 / GIF files",
        file_count="multiple",
        file_types=[".mov", ".mp4", ".gif"],
        type="filepath"
    )

    output_format = gr.Radio(
        [
            "WebM (VP9)",
            "MP4 (H264)",
            "GIF",
            "MOV (ProRes 4444)"
        ],
        value="WebM (VP9)",
        label="Export Format"
    )

    # Added Output Directory Input Textbox
    output_dir = gr.Textbox(
        label="Custom Output Directory (Optional)",
        placeholder="e.g., /path/to/output/folder (Leave blank to save next to source files)",
        value=""
    )

    preset = gr.Radio(
        [
            "Fast",
            "Balanced",
            "High Quality"
        ],
        value="Balanced",
        label="Quality Preset"
    )

    crf = gr.Slider(
        minimum=18,
        maximum=40,
        value=28,
        step=1,
        label="CRF (Lower = Better Quality)"
    )

    keep_audio = gr.Checkbox(
        value=False,
        label="Keep Audio"
    )

    output_log = gr.Textbox(
        label="Conversion Log",
        lines=20
    )

    convert_button = gr.Button("Convert")

    convert_button.click(
        convert_files,
        inputs=[
            files,
            output_format,
            preset,
            crf,
            keep_audio,
            output_dir  # Added output_dir to inputs mapping
        ],
        outputs=output_log
    )

demo.launch()