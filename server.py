"""Local, same-origin proxy for the recognition experiment. Standard library only."""

import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MODELS = {"gpt-5.6-luna", "gpt-6-astra"}
STATIC_PATHS = {"/", "/index.html", "/style.css", "/engine.js", "/recognition.js", "/app.js", "/ai-experiment.js"}
DATA_URL = re.compile(r"^data:image/png;base64,([A-Za-z0-9+/]+={0,2})$")
SCHEMA = {
    "type": "object",
    "properties": {
        "label": {"type": "string"},
        "evidence": {"type": "string"},
        "unknown": {"type": "boolean"},
    },
    "required": ["label", "evidence", "unknown"],
    "additionalProperties": False,
}
PROMPT = (
    "你只会看到一张图。请独立判断图中最主要的物体或场景，"
    "用一个简短、具体的中文名词或短语填写 label。"
    "只依据可见内容，不猜测原图、不参考之前的图片；若看不出来，"
    "把 label 写为“无法判断”，unknown 写为 true。"
    "evidence 用不超过 30 个汉字描述直接可见的线索。"
    "不要把不确定的猜想写成肯定答案。"
)


def validate_payload(payload):
    if not isinstance(payload, dict) or payload.get("model") not in MODELS:
        raise ValueError("请选择受支持的视觉模型。")
    image = payload.get("image")
    if not isinstance(image, str) or len(image) > 2_500_000:
        raise ValueError("节点图无效或过大。")
    match = DATA_URL.fullmatch(image)
    if not match:
        raise ValueError("只接受 PNG 格式的节点图。")
    try:
        image_bytes = base64.b64decode(match.group(1), validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError("图像 Base64 无效。") from error
    if not image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("图像不是 PNG。")
    return payload["model"], image


def build_openai_body(model, image):
    return {
        "model": model,
        "store": False,
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": PROMPT},
            {"type": "input_image", "image_url": image, "detail": "high"},
        ]}],
        "text": {"format": {"type": "json_schema", "name": "image_recognition", "strict": True, "schema": SCHEMA}},
    }


def parse_openai_response(payload):
    if payload.get("status") != "completed":
        raise ValueError("模型未完成本次识别。")
    for item in payload.get("output", []):
        if item.get("type") != "message":
            continue
        for part in item.get("content", []):
            if part.get("type") == "refusal":
                raise ValueError("模型拒绝回答这张图。")
            if part.get("type") == "output_text":
                answer = json.loads(part.get("text", ""))
                if not isinstance(answer, dict) or not isinstance(answer.get("label"), str) or not isinstance(answer.get("evidence"), str) or not isinstance(answer.get("unknown"), bool):
                    raise ValueError("模型回答格式无效。")
                return {
                    "label": answer["label"][:100], "evidence": answer["evidence"][:180], "unknown": answer["unknown"],
                    "model_id": str(payload.get("model", ""))[:100], "response_id": str(payload.get("id", ""))[:100],
                }
    raise ValueError("模型未返回可读取的识别结果。")


def call_openai(model, image, key):
    body = json.dumps(build_openai_body(model, image)).encode("utf-8")
    request = urllib.request.Request("https://api.openai.com/v1/responses", body, {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=75) as response:
            return parse_openai_response(json.load(response))
    except urllib.error.HTTPError as error:
        try:
            remote = json.load(error).get("error", {}).get("message", "")
        except (ValueError, AttributeError):
            remote = ""
        if error.code == 401:
            raise ValueError("OpenAI API 密钥无效或已过期。") from error
        if error.code == 429:
            raise ValueError("OpenAI API 达到速率或额度限制。") from error
        raise ValueError(f"OpenAI API 返回 {error.code}：{remote[:180] or '请求失败'}") from error
    except urllib.error.URLError as error:
        raise ValueError("无法连接 OpenAI API，请检查网络。") from error


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format_string, *args):
        # No request bodies, image data, or credentials in server logs.
        if self.path.startswith("/api/"):
            return
        super().log_message(format_string, *args)

    def json_response(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/status":
            return self.json_response(200, {"ready": bool(os.environ.get("OPENAI_API_KEY"))})
        if urllib.parse.urlsplit(self.path).path not in STATIC_PATHS:
            return self.send_error(404, "Not found")
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/recognize":
            return self.json_response(404, {"error": "未知接口。"})
        origin = self.headers.get("Origin", "")
        host = self.headers.get("Host", "")
        if not re.fullmatch(r"(?:127\.0\.0\.1|localhost)(?::\d{1,5})?", host):
            return self.json_response(403, {"error": "只允许本机地址访问。"})
        if origin and origin != f"http://{host}":
            return self.json_response(403, {"error": "只允许同源页面调用。"})
        if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
            return self.json_response(415, {"error": "请求格式必须为 JSON。"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= 2_600_000:
            return self.json_response(413, {"error": "节点图请求过大或为空。"})
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            return self.json_response(503, {"error": "未配置 OPENAI_API_KEY。"})
        try:
            payload = json.loads(self.rfile.read(length))
            model, image = validate_payload(payload)
        except ValueError as error:
            return self.json_response(400, {"error": str(error)})
        try:
            return self.json_response(200, call_openai(model, image, key))
        except ValueError as error:
            return self.json_response(502, {"error": str(error)})
        except Exception:
            return self.json_response(502, {"error": "识别服务暂时不可用。"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"逐像实验室：http://127.0.0.1:{port}")
    print("AI 评测：" + ("可用" if os.environ.get("OPENAI_API_KEY") else "等待 OPENAI_API_KEY"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
