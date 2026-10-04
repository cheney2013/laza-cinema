import unittest
from unittest.mock import AsyncMock, patch

from comfyui_client import ComfyUIClient


class _Response:
    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class ComfyOutputSelectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_saved_image_wins_over_earlier_temp_preview(self):
        prompt_id = "prompt-1"
        history = {
            prompt_id: {
                "outputs": {
                    "preview": {"images": [{"filename": "easyPreview_temp.png", "type": "temp"}]},
                    "save": {"images": [{"filename": "cinema_flux2_i2i.png", "type": "output"}]},
                }
            }
        }
        response = _Response(history)

        with patch("comfyui_client.httpx.AsyncClient") as client_cls:
            client = client_cls.return_value.__aenter__.return_value
            client.get = AsyncMock(return_value=response)
            result = await ComfyUIClient()._get_output_images(prompt_id)

        self.assertEqual([{"filename": "cinema_flux2_i2i.png", "type": "output"}], result)

    async def test_temp_only_workflow_keeps_legacy_fallback(self):
        prompt_id = "prompt-2"
        preview = {"filename": "preview.png", "type": "temp"}
        history = {prompt_id: {"outputs": {"preview": {"images": [preview]}}}}
        response = _Response(history)

        with patch("comfyui_client.httpx.AsyncClient") as client_cls:
            client = client_cls.return_value.__aenter__.return_value
            client.get = AsyncMock(return_value=response)
            result = await ComfyUIClient()._get_output_images(prompt_id)

        self.assertEqual([preview], result)


if __name__ == "__main__":
    unittest.main()
