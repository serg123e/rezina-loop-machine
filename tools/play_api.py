#!/usr/bin/env python3
"""Запрос к Google Play Developer API ключом сервисного аккаунта ~/.android-keys/play-api.json.

    tools/play_api.py GET  /applications/it.automate123.rezina/reviews
    tools/play_api.py POST /applications/it.automate123.rezina/edits '{}'

Сервисный аккаунт play-publisher@play-publisher-123automate.iam.gserviceaccount.com (GCP-проект
play-publisher-123automate, аккаунт serg123e) приглашён в Play Console с правами на выпуск и карточку
для всех приложений. Как модуль: from play_api import api, upload. Копия ~/dev/skeeto/tools/play_api.py.
"""
import json, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path
import jwt

KEY = json.loads((Path.home() / ".android-keys" / "play-api.json").read_text())
BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3"
UPLOAD = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3"


def _token():
    now = int(time.time())
    assertion = jwt.encode({"iss": KEY["client_email"], "scope": "https://www.googleapis.com/auth/androidpublisher",
                            "aud": KEY["token_uri"], "iat": now, "exp": now + 3600},
                           KEY["private_key"], algorithm="RS256", headers={"kid": KEY["private_key_id"]})
    body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion}).encode()
    return json.loads(urllib.request.urlopen(KEY["token_uri"], body).read())["access_token"]


_tok = {"t": 0, "v": ""}


def bearer():
    """Токен Google живёт час — перевыпускаем каждые 50 мин (make release может идти долго)."""
    if time.time() - _tok["t"] > 3000:
        _tok.update(t=time.time(), v=_token())
    return _tok["v"]


def _call(req):
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{req.get_method()} {req.full_url} → {e.code}\n{e.read().decode()}")


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    return _call(urllib.request.Request(BASE + path, data=data, method=method,
                                        headers={"Authorization": f"Bearer {bearer()}", "Content-Type": "application/json"}))


def upload(path, file, content_type="application/octet-stream"):
    """Загрузка файла (AAB, картинка) — media upload: POST UPLOAD+path?uploadType=media."""
    data = Path(file).read_bytes()
    return _call(urllib.request.Request(UPLOAD + path + "?uploadType=media", data=data, method="POST",
                                        headers={"Authorization": f"Bearer {bearer()}", "Content-Type": content_type}))


def download(path, out):
    """Файл целиком (сгенерированный Play APK): GET BASE+path?alt=media → out."""
    req = urllib.request.Request(BASE + path + "?alt=media", headers={"Authorization": f"Bearer {bearer()}"})
    try:
        with urllib.request.urlopen(req) as r:
            Path(out).write_bytes(r.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"GET {req.full_url} → {e.code}\n{e.read().decode()}")


if __name__ == "__main__":
    a = sys.argv[1:]
    method = a.pop(0) if a[0] in ("GET", "POST", "PUT", "PATCH", "DELETE") else "GET"
    print(json.dumps(api(method, a[0], json.loads(a[1]) if len(a) > 1 else None), indent=1, ensure_ascii=False))
