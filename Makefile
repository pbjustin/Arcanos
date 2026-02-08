.PHONY: install build test lint dev validate clean

install:
	npm install
	pip install -r daemon-python/requirements.txt

build:
	npm run build

test:
	npm test
	pytest daemon-python/tests/ -q

lint:
	npm run lint
	flake8 daemon-python/arcanos/

dev:
	npm run dev

validate:
	npm run validate:all

clean:
	rm -rf dist/ coverage/ .pytest_cache/ daemon-python/.pytest_cache/
