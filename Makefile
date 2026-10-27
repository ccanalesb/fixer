.PHONY: dev dev-down app

app:
	bash apps/desktop/scripts/fetch-node.sh
	bash apps/desktop/scripts/stage-resources.sh
	cd apps/desktop && npm run build

dev:
	bash ./scripts/dev-down.sh || true
	bash ./scripts/dev-up.sh

dev-down:
	bash ./scripts/dev-down.sh

