"""Add the MLflow gateway endpoints LoadLab needs. Safe to re-run: existing names are skipped.

- chat-nofb: same mock primary as `chat`, without the fallback, for the fallback-off case.
- one endpoint per MiniMax model, reaching MiniMax through the tap proxy. The stored secret is a
  placeholder; the tap swaps in the real key.
"""
import sys

from mlflow.entities.gateway_endpoint import GatewayEndpointModelConfig, GatewayModelLinkageType
from mlflow.tracking import MlflowClient

URI = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5050"
MODELS = ["MiniMax-M2.7-highspeed", "MiniMax-M2.7", "MiniMax-M2.5-highspeed", "MiniMax-M2.5", "MiniMax-M3", "MiniMax-M3.1-Flash"]

store = MlflowClient(tracking_uri=URI)._tracking_client.store
existing = {e.name for e in store.list_gateway_endpoints()}
models = {m.name: m for m in store.list_gateway_model_definitions()}
secrets = {s.secret_name: s for s in store.list_secret_infos()}


def primary(model_definition_id):
    return [GatewayEndpointModelConfig(model_definition_id=model_definition_id, linkage_type=GatewayModelLinkageType.PRIMARY, weight=1.0)]


if "chat-nofb" not in existing:
    store.create_gateway_endpoint(name="chat-nofb", model_configs=primary(models["litellm-model"].model_definition_id))
    print("created chat-nofb")

if "minimax-tap-key" in secrets:
    secret_id = secrets["minimax-tap-key"].secret_id
else:
    secret_id = store.create_gateway_secret(
        secret_name="minimax-tap-key",
        secret_value={"api_key": "sk-placeholder-replaced-by-tap"},
        provider="openai",
        auth_config={"api_base": "http://127.0.0.1:18090/v1"},
    ).secret_id

for model in MODELS:
    if model in existing:
        continue
    definition = f"tap-{model}"
    if definition in models:
        definition_id = models[definition].model_definition_id
    else:
        definition_id = store.create_gateway_model_definition(
            name=definition, secret_id=secret_id, provider="openai", model_name=model
        ).model_definition_id
    store.create_gateway_endpoint(name=model, model_configs=primary(definition_id))
    print("created", model)

print("endpoints:", sorted(e.name for e in store.list_gateway_endpoints()))
