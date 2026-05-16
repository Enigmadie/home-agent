.PHONY: install dev build start typecheck check db-generate db-migrate sync-notes clean

OBSIDIAN_PI5_SOURCE ?= $(HOME)/Documents/Obsidian Vault/Projects/Pi 5 infrastructure
PI_NOTES_PROJECTS_DIR ?= /home/godo/notes/obsidian-vault/Projects

install:
	npm install

dev:
	npm run dev

build:
	npm run build

start:
	npm start

typecheck:
	npm run typecheck

check: typecheck build

db-generate:
	npm run db:generate

db-migrate:
	npm run db:migrate

sync-notes:
	@test -n "$(PI_NOTES_REMOTE)" || (printf 'Set PI_NOTES_REMOTE, for example: make sync-notes PI_NOTES_REMOTE=user@host\n' >&2; exit 1)
	@test -d "$(OBSIDIAN_PI5_SOURCE)" || (printf 'Missing Obsidian source: %s\n' "$(OBSIDIAN_PI5_SOURCE)" >&2; exit 1)
	ssh "$(PI_NOTES_REMOTE)" "mkdir -p '$(PI_NOTES_PROJECTS_DIR)'"
	rsync -az --delete \
		--exclude '.DS_Store' \
		--exclude '.obsidian/' \
		--exclude '.trash/' \
		"$(OBSIDIAN_PI5_SOURCE)" \
		"$(PI_NOTES_REMOTE):$(PI_NOTES_PROJECTS_DIR)/"

clean:
	rm -rf dist
