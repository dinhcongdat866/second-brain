from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str
    anthropic_api_key: str
    supabase_url: str = ""            # e.g. https://xxxx.supabase.co
    embedding_model: str = "all-MiniLM-L6-v2"
    # Comma-separated list of exact allowed CORS origins (e.g. localhost).
    allowed_origins: str = "http://localhost:5173"
    # Regex for origins allowed by pattern. Vercel mints a new URL per
    # deployment/preview, so an exact list always goes stale — match them all.
    allowed_origin_regex: str = r"https://.*\.vercel\.app"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


settings = Settings()
