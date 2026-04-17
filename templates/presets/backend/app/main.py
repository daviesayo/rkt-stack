"""FastAPI entry point for {{PROJECT_NAME_PASCAL}}."""
from fastapi import FastAPI

app = FastAPI(title="{{PROJECT_NAME_PASCAL}}")


@app.get("/v1/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}
