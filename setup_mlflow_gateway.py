"""Create the MLflow gateway endpoint `chat` (primary: mock LiteLLM, fallback: mock DashScope) via REST."""
import os
import sys
from mlflow.tracking import MlflowClient
from mlflow.entities.gateway_endpoint import (FallbackConfig, FallbackStrategy, GatewayEndpointModelConfig,
                                              GatewayModelLinkageType, RoutingStrategy)

uri = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5050"
store = MlflowClient(tracking_uri=uri)._tracking_client.store
ids = []
for name, port in [("litellm", 18001), ("dashscope", 18002)]:
    sec = store.create_gateway_secret(secret_name=f"{name}-key", secret_value={"api_key": "sk-mock"},
                                      provider="openai", auth_config={"api_base": f"http://127.0.0.1:{port}/v1"})
    md = store.create_gateway_model_definition(name=f"{name}-model", secret_id=sec.secret_id,
                                               provider="openai", model_name="mock-model")
    ids.append(md.model_definition_id)
ep = store.create_gateway_endpoint(
    name="chat",
    model_configs=[
        GatewayEndpointModelConfig(model_definition_id=ids[0], linkage_type=GatewayModelLinkageType.PRIMARY, weight=1.0),
        GatewayEndpointModelConfig(model_definition_id=ids[1], linkage_type=GatewayModelLinkageType.FALLBACK,
                                   weight=1.0, fallback_order=1),
    ],
    routing_strategy=RoutingStrategy.REQUEST_BASED_TRAFFIC_SPLIT,
    fallback_config=FallbackConfig(strategy=FallbackStrategy.SEQUENTIAL, max_attempts=2),
    experiment_id=os.environ.get("EXPERIMENT_ID"),
)
print("endpoint", ep.endpoint_id, ep.name, "experiment", ep.experiment_id)
