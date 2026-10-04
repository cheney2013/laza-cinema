import os
import logging
import torch
import numpy as np

import comfy.model_management as mm
from comfy.utils import load_torch_file
import folder_paths

script_directory = os.path.dirname(os.path.abspath(__file__))
device = mm.get_torch_device()
offload_device = mm.unet_offload_device()

local_model_path = os.path.join(folder_paths.models_dir, "nlf", "nlf_l_multi_0.3.2.torchscript")
folder_paths.add_model_folder_path("nlf", os.path.join(folder_paths.models_dir, "nlf"))

log = logging.getLogger("nlf_minimal")

def check_jit_script_function():
    if torch.jit.script.__name__ != "script":
        # Get more details about what modified it
        module = torch.jit.script.__module__
        qualname = getattr(torch.jit.script, '__qualname__', 'unknown')
        code_file = None
        try:
            code_file = torch.jit.script.__code__.co_filename
            code_line = torch.jit.script.__code__.co_firstlineno
            log.warning(f"torch.jit.script has been modified by another custom node.\n"
                    f"  Function name: {torch.jit.script.__name__}\n"
                    f"  Module: {module}\n"
                    f"  Qualified name: {qualname}\n"
                    f"  Defined in: {code_file}:{code_line}\n"
                    f"This may cause issues with the NLF model.")
        except:
            log.warning("--------------------------------")
            log.warning(f"torch.jit.script function is: {torch.jit.script.__name__} from module {module}, "
                    f"this has been modified by another custom node. This may cause issues with the NLF model.")
            log.warning("--------------------------------")

model_list = [
    "https://github.com/isarandi/nlf/releases/download/v0.3.2/nlf_l_multi_0.3.2.torchscript",
    "https://github.com/isarandi/nlf/releases/download/v0.2.2/nlf_l_multi_0.2.2.torchscript",
]

class DownloadAndLoadNLFModel:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "url": (model_list, {"default": "https://github.com/isarandi/nlf/releases/download/v0.3.2/nlf_l_multi_0.3.2.torchscript"}),
             },
             "optional": {
                 "warmup": ("BOOLEAN", {"default": True, "tooltip": "Whether to warmup the model after loading"}),
             },
        }

    RETURN_TYPES = ("NLFMODEL",)
    RETURN_NAMES = ("nlf_model", )
    FUNCTION = "loadmodel"
    CATEGORY = "WanVideoWrapper"

    def loadmodel(self, url, warmup=True):
        if url not in model_list:
            raise ValueError(f"URL {url} is not in the list of allowed models.")
        check_jit_script_function()

        if not os.path.exists(local_model_path):
            log.info(f"Downloading NLF model to: {local_model_path}")
            import requests
            os.makedirs(os.path.dirname(local_model_path), exist_ok=True)
            response = requests.get(url)
            if response.status_code == 200:
                with open(local_model_path, "wb") as f:
                    f.write(response.content)
            else:
                print("Failed to download file:", response.status_code)

        model = torch.jit.load(local_model_path).eval()

        if warmup:
            log.info("Warming up NLF model...")
            dummy_input = torch.zeros(1, 3, 256, 256, device=device)
            jit_profiling_prev_state = torch._C._jit_set_profiling_executor(True)
            try:
                for _ in range(2):
                    _ = model.detect_smpl_batched(dummy_input)
            finally:
                torch._C._jit_set_profiling_executor(jit_profiling_prev_state)

            log.info("NLF model warmed up")

        model = model.to(offload_device)

        return (model,)

class NLFPredict:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
            "model": ("NLFMODEL",),
            "images": ("IMAGE", {"tooltip": "Input images for the model"}),
            },
            "optional": {
                "per_batch": ("INT", {"default": -1, "min": -1, "max": 10000, "step": 1, "tooltip": "How many images to process at once. -1 means all at once."}),
            }
        }

    RETURN_TYPES = ("NLFPRED", "BBOX",)
    RETURN_NAMES = ("pose_results", "bboxes")
    FUNCTION = "predict"
    CATEGORY = "WanVideoWrapper"

    def predict(self, model, images, per_batch=-1):

        check_jit_script_function()
        model = model.to(device)

        num_images = images.shape[0]

        # Determine batch size
        if per_batch == -1:
            batch_size = num_images
        else:
            batch_size = per_batch

        # Initialize result containers
        all_boxes = []
        all_joints3d_nonparam = []

        # Process in batches
        for i in range(0, num_images, batch_size):
            end_idx = min(i + batch_size, num_images)
            batch_images = images[i:end_idx]

            jit_profiling_prev_state = torch._C._jit_set_profiling_executor(True)
            try:
                pred = model.detect_smpl_batched(batch_images.permute(0, 3, 1, 2).to(device))
            finally:
                torch._C._jit_set_profiling_executor(jit_profiling_prev_state)

            # Collect boxes and joints from this batch
            if 'boxes' in pred:
                all_boxes.extend(pred['boxes'])
            if 'joints3d_nonparam' in pred:
                all_joints3d_nonparam.extend(pred['joints3d_nonparam'])

        model = model.to(offload_device)

        # Move collected results to offload device
        all_boxes = [box.to(offload_device) for box in all_boxes]
        all_joints3d_nonparam = [joints.to(offload_device) for joints in all_joints3d_nonparam]

        # Maintain the original nested format: wrap in a list to match expected structure
        pose_results = {
            'joints3d_nonparam': [all_joints3d_nonparam],
        }

        # Convert bboxes to list format: [x_min, y_min, x_max, y_max] for each detection
        # Each box tensor is shape (1, 5) with [x_min, y_min, x_max, y_max, confidence]
        formatted_boxes = []
        for box in all_boxes:
            # Handle empty detections (no person detected in frame)
            if box.numel() == 0 or box.shape[0] == 0:
                formatted_boxes.append([0.0, 0.0, 0.0, 0.0])
            else:
                # Extract first 4 values (x_min, y_min, x_max, y_max), drop confidence
                bbox_values = box[0, :4].cpu().tolist()
                formatted_boxes.append(bbox_values)

        return (pose_results, formatted_boxes)

NODE_CLASS_MAPPINGS = {
    "DownloadAndLoadNLFModel": DownloadAndLoadNLFModel,
    "NLFPredict": NLFPredict,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "DownloadAndLoadNLFModel": "(Download)Load NLF Model",
    "NLFPredict": "NLF Predict",
}
