"""Femto Group: transcribe one audio note on this PC with faster-whisper. Nothing is sent anywhere (the model is already cached locally).

Usage: python femto-transcribe.py <audio file> [--model small] [--max-seconds 1805] [--threads 6]

Prints ONE line of JSON (ASCII only) on stdout:
  {"ok": true, "duration": 812.4, "language": "es", "text": "..."}          transcribed
  {"ok": false, "error": "too_long", "duration": 2400.0}                     longer than --max-seconds; nothing was transcribed
  {"ok": false, "error": "..."}                                              could not read it
Runs on the CPU (int8) on purpose: the GPU belongs to the UE5 stream and the local language model.
"""
import argparse
import json
import sys


def emit(obj, code):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()
    return code


def container_seconds(path):
    """The length the file says it has, without decoding it. None if the container doesn't say."""
    try:
        import av
        with av.open(path) as c:
            if c.duration:
                return c.duration / 1_000_000          # av.time_base: microseconds
    except Exception:
        return None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default="small")
    ap.add_argument("--max-seconds", type=float, default=1805.0)
    ap.add_argument("--threads", type=int, default=6)
    a = ap.parse_args()

    declared = container_seconds(a.audio)
    if declared is not None and declared > a.max_seconds:
        return emit({"ok": False, "error": "too_long", "duration": round(declared, 1)}, 3)

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        return emit({"ok": False, "error": "faster-whisper is not installed for this Python: " + str(e)[:160]}, 2)

    try:
        model = WhisperModel(a.model, device="cpu", compute_type="int8", cpu_threads=max(1, a.threads))
        segments, info = model.transcribe(a.audio, vad_filter=True, beam_size=5)
    except Exception as e:
        return emit({"ok": False, "error": "could not read the audio: " + str(e)[:160]}, 2)

    if info.duration and info.duration > a.max_seconds:
        return emit({"ok": False, "error": "too_long", "duration": round(info.duration, 1)}, 3)

    # One paragraph per stretch of speech: a pause longer than 1.5 s starts a new one, so the transcript is easy to edit.
    paragraphs, current, last_end = [], [], None
    for s in segments:
        text = s.text.strip()
        if not text:
            continue
        if current and last_end is not None and s.start - last_end > 1.5:
            paragraphs.append(" ".join(current))
            current = []
        current.append(text)
        last_end = s.end
    if current:
        paragraphs.append(" ".join(current))

    return emit({"ok": True, "duration": round(info.duration or 0, 1), "language": info.language, "text": "\n\n".join(paragraphs)}, 0)


if __name__ == "__main__":
    sys.exit(main())
