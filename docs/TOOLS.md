# Tool reference

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: npm run build && npm run gen:docs -->

20 tools total. 17 are exposed by default; the rest require an
environment variable to be set by whoever runs the server (see the README).

| Tool | Exposed by default |
|---|---|
| [`list_recipes`](#listrecipes) | yes |
| [`get_recipe`](#getrecipe) | yes |
| [`get_recipe_nutrition`](#getrecipenutrition) | yes |
| [`list_recipe_ingredients`](#listrecipeingredients) | yes |
| [`get_recipe_ingredient`](#getrecipeingredient) | yes |
| [`list_ingredients`](#listingredients) | yes |
| [`get_ingredient`](#getingredient) | yes |
| [`create_recipe`](#createrecipe) | yes |
| [`create_recipe_shortcut`](#createrecipeshortcut) | yes |
| [`update_recipe`](#updaterecipe) | yes |
| [`scale_recipe`](#scalerecipe) | yes |
| [`create_subrecipe`](#createsubrecipe) | yes |
| [`delete_recipe`](#deleterecipe) | no — needs `RECIPAL_MCP_ALLOW_DELETE=1` |
| [`create_recipe_ingredient`](#createrecipeingredient) | yes |
| [`update_recipe_ingredient`](#updaterecipeingredient) | yes |
| [`delete_recipe_ingredient`](#deleterecipeingredient) | no — needs `RECIPAL_MCP_ALLOW_DELETE=1` |
| [`update_ingredient`](#updateingredient) | yes |
| [`bulk_create_subrecipes`](#bulkcreatesubrecipes) | yes |
| [`bulk_clone_and_swap`](#bulkcloneandswap) | yes |
| [`recipal_request`](#recipalrequest) | no — needs `RECIPAL_MCP_ENABLE_RAW=1` |

## list_recipes

List recipes from ReciPal with IDs, names, and tags. Paginated; per_page max 20. Larger values are silently reduced to 20, so callers must paginate.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no | 1-based page number (default 1). |
| `per_page` | integer | no | Items per page (default 20, max 20; larger values are silently reduced). |

## get_recipe

Get one recipe in full, including nutrition, serving size, package yield, tags and label settings. Use this to read a template recipe's exact settings before cloning it.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `recipe_id` | string | yes | ReciPal recipe ID. |

## get_recipe_nutrition

Get only the nutrition sub-object for a recipe.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `recipe_id` | string | yes |  |

## list_recipe_ingredients

List every ingredient line on a recipe, with recipe_ingredient IDs, ingredient IDs, quantities, units and total_grams.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `recipe_id` | string | yes |  |

## get_recipe_ingredient

Get one ingredient line on a recipe.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `recipe_id` | string | yes |  |
| `recipe_ingredient_id` | string | yes |  |

## list_ingredients

List the account's ingredient library. Subrecipes appear here once created, which is how you find the ingredient_id needed to add a subrecipe to another recipe. Paginated; per_page max 20. Larger values are silently reduced to 20, so callers must paginate.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `page` | integer | no |  |
| `per_page` | integer | no | Default 20, max 20; larger values are silently reduced. |
| `search` | string | no | Optional name filter, if supported. |

## get_ingredient

Get one ingredient with its full nutrition data and available units.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `ingredient_id` | string | yes |  |

## create_recipe

Create a new empty recipe. POST /recipes. Prefer scale_recipe (clone a fully-configured template) when you need label settings to match existing recipes.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `fields` | object | yes | Open key/value object of attributes. Keys are passed straight through to the ReciPal API namespaced under the resource (e.g. {name, package_yield_quantity, package_yield_unit, servings, packages, suggested_serving, sku, preparation, visual_unit_of_measure}). Call get_recipe on an existing recipe first to see the exact attribute names this account uses. Note that tags cannot be set here -- ReciPal accepts the request and silently ignores a tags string, and errors on other shapes. Tags do carry forward through scale_recipe when cloning a tagged template. |
| `as_json` | boolean | no | Send JSON instead of form encoding. |

## create_recipe_shortcut

Create a complete recipe with its ingredients in one request. POST /recipes/shortcut. The fastest path for building many recipes. Requires ingredient_ids and ingredient_weights: parallel lists of the same length, weights in grams. Either may be given as an array or a comma-separated string. Note this does NOT inherit label settings from an existing recipe -- serving size, package yield and tags all come back unset, so use scale_recipe to clone a configured template when label settings matter.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `fields` | object | yes | Open key/value object of attributes. Keys are passed straight through to the ReciPal API namespaced under the resource (e.g. {name, package_yield_quantity, package_yield_unit, servings, packages, suggested_serving, sku, preparation, visual_unit_of_measure}). Call get_recipe on an existing recipe first to see the exact attribute names this account uses. Note that tags cannot be set here -- ReciPal accepts the request and silently ignores a tags string, and errors on other shapes. Tags do carry forward through scale_recipe when cloning a tagged template. Also include ingredient_ids and ingredient_weights: parallel lists of the same length, weights in grams. Either may be an array or a comma-separated string. |
| `as_json` | boolean | no |  |

## update_recipe

Update a recipe's attributes. PUT /recipes/{id}.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `recipe_id` | string | yes |  |
| `fields` | object | yes | Open key/value object of attributes. Keys are passed straight through to the ReciPal API namespaced under the resource (e.g. {name, package_yield_quantity, package_yield_unit, servings, packages, suggested_serving, sku, preparation, visual_unit_of_measure}). Call get_recipe on an existing recipe first to see the exact attribute names this account uses. Note that tags cannot be set here -- ReciPal accepts the request and silently ignores a tags string, and errors on other shapes. Tags do carry forward through scale_recipe when cloning a tagged template. |
| `as_json` | boolean | no |  |

## scale_recipe

Copy (and optionally scale) an existing recipe. POST /recipes/{id}/scale. This is the copy-and-swap primitive: cloning a configured template carries its label settings and tags forward, so you only replace one ingredient afterward. Pass a scale factor of 1 for a straight copy.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `recipe_id` | string | yes | Recipe to copy. |
| `fields` | object | no | e.g. {name: 'New Recipe Name', scale_factor: 1}. Parameter names for this endpoint are not published; run once against a throwaway recipe to confirm. |
| `as_json` | boolean | no |  |

## create_subrecipe

Flag an existing recipe as a subrecipe so it becomes usable as an ingredient in other recipes. POST /recipes/{id}/create_subrecipe. Returns the new ingredient record — capture its ingredient_id, that is what you add to other recipes.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `recipe_id` | string | yes |  |
| `fields` | object | no | Optional attributes (e.g. name). |
| `as_json` | boolean | no |  |

## delete_recipe

> **Disabled by default.** Set `RECIPAL_MCP_ALLOW_DELETE=1` in the server environment and restart to expose this tool.

Delete a recipe. DESTRUCTIVE and irreversible — requires confirm:true, and the server must have been started with RECIPAL_MCP_ALLOW_DELETE=1.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `recipe_id` | string | yes |  |
| `confirm` | boolean | yes | Must be true. |

## create_recipe_ingredient

Add an ingredient line to a recipe. POST /recipes/{id}/recipe_ingredients. Accepts ingredient_id (required) plus unit + quantity, or total_grams.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `recipe_id` | string | yes |  |
| `fields` | object | yes | {ingredient_id (required), unit?, quantity?, waste?, total_grams?}. unit must be one of the ingredient's available units. |
| `as_json` | boolean | no |  |

## update_recipe_ingredient

Update one ingredient line. PUT /recipes/{id}/recipe_ingredients/{ri_id}. NOTE: this endpoint silently ignores ingredient_id — it returns 200 with the original ingredient still attached. To swap one ingredient for another you must delete the line and create a new one.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `recipe_id` | string | yes |  |
| `recipe_ingredient_id` | string | yes |  |
| `fields` | object | yes | {unit?, quantity?, waste?, total_grams?} — ingredient_id is ignored. |
| `as_json` | boolean | no |  |

## delete_recipe_ingredient

> **Disabled by default.** Set `RECIPAL_MCP_ALLOW_DELETE=1` in the server environment and restart to expose this tool.

Remove an ingredient line from a recipe. DESTRUCTIVE — requires confirm:true, and the server must have been started with RECIPAL_MCP_ALLOW_DELETE=1.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `recipe_id` | string | yes |  |
| `recipe_ingredient_id` | string | yes |  |
| `confirm` | boolean | yes |  |

## update_ingredient

Update an ingredient in the library. PUT /ingredients/{id}. Use for renaming (e.g. stripping '(copy)' suffixes).

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `ingredient_id` | string | yes |  |
| `fields` | object | yes | e.g. {name: 'Vanilla Concentrate'} |
| `as_json` | boolean | no |  |

## bulk_create_subrecipes

Flag many recipes as subrecipes, sequentially. Defaults to dry_run:true — returns the plan without touching anything. Set dry_run:false AND confirm:true to execute. Returns a per-recipe success/failure report including the new ingredient_ids.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `recipe_ids` | array<string> | yes | Recipe IDs to flag. |
| `dry_run` | boolean | no | Default true. |
| `confirm` | boolean | no | Must be true to execute. |
| `delay_ms` | integer | no | Pause between calls (default 400). |

## bulk_clone_and_swap

The copy-and-swap loop. For each entry: clone template_recipe_id via scale_recipe, rename it, then replace the designated ingredient line with a different ingredient_id. Runs sequentially and independently per entry, so one failure does not poison the rest. Defaults to dry_run:true.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `template_recipe_id` | string | yes | The fully-configured template recipe to clone from. |
| `swap_recipe_ingredient_id` | string | yes | The recipe_ingredient line ID ON THE TEMPLATE that should be replaced. The clone's corresponding line is located by matching ingredient_id. |
| `entries` | array<object> | yes | One entry per new recipe. |
| `dry_run` | boolean | no | Default true. |
| `confirm` | boolean | no | Must be true to execute. |
| `delay_ms` | integer | no |  |

## recipal_request

> **Disabled by default.** Set `RECIPAL_MCP_ENABLE_RAW=1` in the server environment and restart to expose this tool.

Call any ReciPal API endpoint directly. Use this to discover undocumented fields or hit endpoints this server does not wrap yet. Mutating methods (POST/PUT/PATCH/DELETE) require confirm:true, and the server must have been started with RECIPAL_MCP_ENABLE_RAW=1.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `method` | string | yes | GET, POST, PUT, PATCH or DELETE. |
| `path` | string | yes | Path after /api/v1, e.g. '/recipes/123456'. |
| `query` | object | no | Query-string params. |
| `body` | object | no | Request body, form-encoded unless as_json. |
| `as_json` | boolean | no |  |
| `confirm` | boolean | no | Required for mutating methods. |
