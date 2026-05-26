from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str
    anthropic_api_key: str
    embedding_model: str = "all-MiniLM-L6-v2"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
