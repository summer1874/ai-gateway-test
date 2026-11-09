"""Add MLflow gateway endpoints for Command Code models, reached through the cmdtap forwarder (18091).
The stored secret is a placeholder; cmdtap injects the real key. Safe to re-run."""
import sys
from mlflow.entities.gateway_endpoint import GatewayEndpointModelConfig, GatewayModelLinkageType
from mlflow.tracking import MlflowClient

URI = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5050"
MODELS = {"cmd-deepseek-v4-1-flash-fast": "deepseek/deepseek-v4.1-flash-fast",
          "cmd-deepseek-v4-1-flash": "deepseek/deepseek-v4.1-flash",
          "cmd-gpt-5-4-mini": "gpt-5.4-mini"}
store = MlflowClient(tracking_uri=URI)._tracking_client.store
existing = {e.name for e in store.list_gateway_endpoints()}
defs = {m.name: m for m in store.list_gateway_model_definitions()}
secrets = {s.secret_name: s for s in store.list_secret_infos()}
sid = (secrets.get("cmdtap-key") or store.create_gateway_secret(
    secret_name="cmdtap-key", secret_value={"api_key": "sk-placeholder-replaced-by-cmdtap"},
    provider="openai", auth_config={"api_base": "http://127.0.0.1:18091/v1"})).secret_id
for ep, model in MODELS.items():
    if ep in existing:
        continue
    d = defs.get(f"def-{ep}") or store.create_gateway_model_definition(
        name=f"def-{ep}", secret_id=sid, provider="openai", model_name=model)
    store.create_gateway_endpoint(name=ep, model_configs=[GatewayEndpointModelConfig(
        model_definition_id=d.model_definition_id, linkage_type=GatewayModelLinkageType.PRIMARY, weight=1.0)])
    print("created", ep)
