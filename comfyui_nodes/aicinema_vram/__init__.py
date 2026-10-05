"""LAZA CINEMA STUDIO: report what ComfyUI actually holds in VRAM.

ComfyUI lists no loaded models over HTTP (/system_stats gives only totals), so the studio could judge
"is H3 still resident" only from the last graph it ran, and "how much does Qwen take" only from the
weight file's size, which is not what sits on the card (int8 weights, partial and dynamic loading). This
adds one read-only route that asks ComfyUI's own bookkeeping:

    GET /aicinema/loaded_models
    {"models": [{"class": ..., "total": bytes, "loaded": bytes, "device": "cuda:0"}, ...]}

`total` is the model's full size, `loaded` the part of it on its load device right now (with ComfyUI's
dynamic loading, the part its virtual-memory buffer has resident). Nothing is changed or unloaded.
"""
import logging

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

log = logging.getLogger("aicinema_vram")


def loaded_models() -> list:
    import comfy.model_management as mm

    out = []
    for entry in list(mm.current_loaded_models):
        try:
            patcher = entry.model
            if patcher is None:
                continue
            inner = getattr(patcher, "model", None)
            out.append({
                "class": type(inner).__name__ if inner is not None else type(patcher).__name__,
                "patcher": type(patcher).__name__,
                "total": int(entry.model_memory()),
                "loaded": int(entry.model_loaded_memory()),
                "device": str(entry.device),
            })
        except Exception:  # a model being torn down must not break the report
            log.debug("skipped a loaded model", exc_info=True)
    return out


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/aicinema/loaded_models")
    async def _loaded_models_route(request):
        return web.json_response({"models": loaded_models()})
except Exception:  # not running inside ComfyUI (tests, import checks)
    log.debug("route not registered", exc_info=True)
