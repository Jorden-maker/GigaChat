"""
Локальный HTTP-сервис эмбеддингов для GigaChat.

Использует модель intfloat/multilingual-e5-large (или совместимую E5).
Полностью офлайн, работает в корпоративной LAN.

Запуск:
    pip install -r requirements.txt
    python server.py

Конфигурация через переменные окружения:
    EMBED_MODEL  — путь к модели (HuggingFace id или локальная папка).
                   По умолчанию: intfloat/multilingual-e5-large
    EMBED_HOST   — на каком интерфейсе слушать. По умолчанию: 0.0.0.0
    EMBED_PORT   — порт. По умолчанию: 8001
    EMBED_DEVICE — cpu / cuda / mps. По умолчанию: auto

API:
    POST /embed
        body: {"input": "<текст>", "type": "passage" | "query"}
        resp: {"embedding": [...], "dim": 1024, "model": "..."}
        Поле type необязательно. Для индексации документов — "passage",
        для запроса пользователя — "query". E5 этого требует.

    POST /embed_batch
        body: {"input": ["t1", "t2", ...], "type": "passage"}
        resp: {"data": [{"embedding": [...]}, ...], "dim": 1024}
        Формат "data": [...].embedding совместим с OpenAI-style API,
        чтобы n8n-узел мог распарсить ответ как раньше.

    GET /health
        resp: {"status": "ok", "model": "...", "dim": 1024}
"""

import os
import logging
from typing import List, Optional, Union

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import torch


MODEL_NAME = os.environ.get('EMBED_MODEL', 'intfloat/multilingual-e5-large')
HOST = os.environ.get('EMBED_HOST', '0.0.0.0')
PORT = int(os.environ.get('EMBED_PORT', '8001'))
DEVICE = os.environ.get('EMBED_DEVICE', '')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger('embed-server')


def pick_device() -> str:
    if DEVICE:
        return DEVICE
    if torch.cuda.is_available():
        return 'cuda'
    if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
        return 'mps'
    return 'cpu'


log.info('Loading model: %s', MODEL_NAME)
device = pick_device()
log.info('Device: %s', device)
model = SentenceTransformer(MODEL_NAME, device=device)
# E5-large размерность вектора: 1024
EMB_DIM = model.get_sentence_embedding_dimension()
log.info('Model loaded. Embedding dim: %d', EMB_DIM)


app = FastAPI(title='GigaChat Embeddings (E5)')


class EmbedRequest(BaseModel):
    input: Union[str, List[str]]
    type: Optional[str] = 'passage'  # 'passage' для документов, 'query' для запроса


def add_e5_prefix(texts: List[str], kind: str) -> List[str]:
    """E5 требует префикс 'passage: ' или 'query: ' для лучшего качества."""
    prefix = 'query: ' if kind == 'query' else 'passage: '
    return [prefix + t for t in texts]


def encode(texts: List[str], kind: str) -> List[List[float]]:
    prepared = add_e5_prefix(texts, kind)
    vectors = model.encode(
        prepared,
        batch_size=8,
        normalize_embeddings=True,  # cosine similarity готова
        show_progress_bar=False,
    )
    return [v.tolist() for v in vectors]


@app.get('/health')
def health():
    return {'status': 'ok', 'model': MODEL_NAME, 'dim': EMB_DIM, 'device': device}


@app.post('/embed')
def embed(req: EmbedRequest):
    if isinstance(req.input, list):
        raise HTTPException(400, 'Для batch используйте /embed_batch')
    if not req.input or not req.input.strip():
        raise HTTPException(400, 'Пустой input')
    kind = (req.type or 'passage').lower()
    if kind not in ('passage', 'query'):
        raise HTTPException(400, "type должен быть 'passage' или 'query'")
    try:
        vectors = encode([req.input], kind)
        return {
            'embedding': vectors[0],
            'dim': EMB_DIM,
            'model': MODEL_NAME,
        }
    except Exception as e:
        log.exception('Embed error')
        raise HTTPException(500, str(e))


@app.post('/embed_batch')
def embed_batch(req: EmbedRequest):
    if isinstance(req.input, str):
        inputs = [req.input]
    else:
        inputs = list(req.input)
    if not inputs:
        raise HTTPException(400, 'Пустой input')
    kind = (req.type or 'passage').lower()
    if kind not in ('passage', 'query'):
        raise HTTPException(400, "type должен быть 'passage' или 'query'")
    try:
        vectors = encode(inputs, kind)
        return {
            'data': [{'embedding': v, 'index': i} for i, v in enumerate(vectors)],
            'dim': EMB_DIM,
            'model': MODEL_NAME,
        }
    except Exception as e:
        log.exception('Embed batch error')
        raise HTTPException(500, str(e))


if __name__ == '__main__':
    log.info('Starting on http://%s:%d', HOST, PORT)
    uvicorn.run(app, host=HOST, port=PORT, log_level='info')
