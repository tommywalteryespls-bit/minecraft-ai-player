import type { FunctionTool } from 'openai/resources/responses/responses';

const object = (
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties)
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

const position = object({ x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } });
const nullablePosition = { anyOf: [position, { type: 'null' }] };

const define = (name: string, description: string, parameters: Record<string, unknown>): FunctionTool => ({
  type: 'function',
  name,
  description,
  strict: true,
  parameters
});

const fabricDescriptions: Record<string, string> = {
  move_to: 'Fabric: direct ground movement to coordinates within 64 blocks. No pathfinding; stops at obstacles, drops, hazards, or timeout.',
  move_near: 'Fabric: direct ground movement within a radius of coordinates within 64 blocks. No pathfinding; stops at obstacles, drops, or hazards.',
  follow_player: 'Fabric: start following another loaded player for at most 60 seconds using direct ground movement. Stops if blocked, unsafe, or the player disappears. Cannot follow the controlled player itself.',
  mine_block: 'Fabric: mine one visible named block or coordinate already within interaction reach per call. Repeat individual calls with valid targets to finish an explicitly requested count. Does not walk to the block or automatically equip a tool; use supported prerequisite actions when needed.',
  equip_item: 'Fabric: select a matching item already in the hotbar into the main hand. Armor, off-hand, and inventory transfers are unsupported.',
  eat_best_food: 'Fabric: eat available food from the hotbar when hungry. Does not move food from the main inventory.'
};

const unrestrictedDescriptions: Record<string, string> = {
  control_player: 'Fabric unrestricted: walk relative to view, turn relative yaw/pitch, jump, use/attack once, mine the reachable crosshair block, or stop automated inputs. Walk duration_ms=0 means keep walking until stopped; a positive duration means that explicit many milliseconds. Only perform interactions relevant to the user request.',
  move_to: 'Fabric unrestricted: direct ground movement to coordinates, no automatic distance or time cutoff. No pathfinding; solid terrain still blocks physical movement. No conservative obstacle/fluid/drop avoidance. Completes on arrival or user cancellation. Leave timeout_ms null unless the user requests a timeout.',
  move_near: 'Fabric unrestricted: direct movement within the requested radius, without an automatic time/distance cutoff or terrain avoidance. Not pathfinding. Leave timeout_ms null unless explicitly requested.',
  follow_player: 'Fabric unrestricted: start following another loaded player until stopped; waits for the target to load again if lost. Direct movement without terrain avoidance. Returns STARTED, not arrival; no need to keep restarting. Cannot follow yourself.'
};

const gameplayDescriptions: Record<string, string> = {
  eat_best_food: 'Fabric: select and eat available food from any player inventory slot when hungry.',
  move_to: 'Fabric: ground A* navigation around obstacles with one-block steps; does not excavate for ordinary movement. No teleportation, bridging or parkour. Leave timeout_ms null unless requested.',
  move_near: 'Fabric: ground A* navigation within the specified radius without excavation. Leave timeout_ms null unless requested.',
  follow_player: 'Fabric: start ground-path following another loaded player. Returns STARTED, not arrival. Cannot follow yourself; unrestricted mode continues until stopped.',
  mine_block: 'Fabric: approach and mine one named block or coordinate, selecting an appropriate existing inventory tool. Can excavate access to this requested mining target; server protections still apply.',
  collect_resource: 'Fabric: search loaded terrain, navigate, mine block sources and pick up drops until inventory increases by the requested amount. May excavate access and explore for ores. Use acquire_item to obtain missing tools and crafting prerequisites.',
  craft_item: 'Fabric: craft the requested output quantity using real vanilla recipes and existing ingredients. May place an owned crafting table if needed. Use acquire_item to gather prerequisites.',
  equip_item: 'Fabric: equip an item from any of the 36 inventory slots into hand, off-hand or the specified armor slot.',
  smelt_item: 'Fabric: smelt up to 64 input items using coal or charcoal and a reachable empty furnace; may place an owned furnace. Takes real in-game smelting time. Existing furnace contents are not overwritten.'
};

export function toolForController(tool: FunctionTool, clientControl: boolean, unrestricted = false, gameplay = false): FunctionTool {
  if (clientControl && gameplay && gameplayDescriptions[tool.name]) return { ...tool, description: gameplayDescriptions[tool.name] };
  if (clientControl && unrestricted && unrestrictedDescriptions[tool.name]) {
    const updated = { ...tool, description: unrestrictedDescriptions[tool.name] };
    if (tool.name === 'control_player') {
      const parameters = tool.parameters as { properties: Record<string, unknown> };
      return { ...updated, parameters: { ...tool.parameters, properties: { ...parameters.properties,
        duration_ms: { type: ['integer', 'null'], minimum: 0, maximum: 2_147_483_647 } } } };
    }
    return updated;
  }
  return clientControl && fabricDescriptions[tool.name] ? { ...tool, description: fabricDescriptions[tool.name] } : tool;
}

export const minecraftTools: FunctionTool[] = [
  define('search_for_base', 'Execute a persistent underground base-search routine ONLY on an explicit search/mining request. Defaults: start at current block/height, facing nearest cardinal, 32-block parallel branches with 4-block centerline spacing, continue until evidence, stop or blocker. max_branches null means no branch-count cap. Requires standing at origin/height; never auto-descends. Uses guarded two-block-high tunneling, scans loaded terrain, saves coverage, stops before suspected structures. May find natural structures, never proves a player base. When this returns, report its outcome and ask before further gameplay; do not bypass a blocker with generic mining.', object({
    origin: { anyOf: [object({ x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } }), { type: 'null' }] },
    height: { type: ['integer', 'null'], minimum: -2048, maximum: 2047 },
    direction: { type: ['string', 'null'], enum: ['north', 'east', 'south', 'west', null] },
    branch_length: { type: ['integer', 'null'], minimum: 1, maximum: 256 },
    branch_spacing: { type: ['integer', 'null'], minimum: 2, maximum: 32 },
    max_branches: { type: ['integer', 'null'], minimum: 1, maximum: 10000 }
  })),
  define('resume_base_search', 'Resume a saved base search ONLY when the user asks, in the same world/dimension and at the last saved cell or interrupted adjacent destination. Rechecks evidence; never ignores a suspected structure. Use inspect_base_search to find the goal ID and return coordinates. No automatic route back, container opening or entry into a suspected base.', object({ id: { type: 'string' } })),
  define('inspect_base_search', 'Read saved base-search progress, dimensions, coverage coordinates and evidence for this world. id null lists searches. This does not move, mine, resume or inspect container contents.', object({ id: { type: ['string', 'null'] } })),
  define('acquire_item', 'Pursue a persistent, inventory-verified item goal: recursively gather resources, make tools/stations, smelt and craft. For a full armor set use diamond_armor (or iron_armor) with amount=1 and equip=true. Ordinary item amounts are total desired holdings, not additional items. This can excavate/explore for necessary materials. Stops on completion, cancellation or a real blocker; saves resumable progress. Only use when the user requests acquisition.', object({ item: { type: 'string' }, amount: { type: 'integer', minimum: 1, maximum: 2304 }, equip: { type: 'boolean' } })),
  define('resume_item_goal', 'Resume an active item-acquisition goal in the current world after the user asks; rechecks inventory and missing prerequisites. Get its ID with list_goals.', object({ id: { type: 'string' } })),
  define('inspect_recipes', 'Read Minecraft 1.21.11 crafting recipes, block sources and supported smelting input for an item, without changing the game.', object({ item: { type: 'string' } })),
  define('control_player', 'Fabric client only: control the logged-in player with a short explicit action. walk is relative movement, turn uses relative yaw (positive right) / pitch (positive down), mine_target breaks only the crosshair block in reach, use right-clicks once, attack attacks once, stop releases automated input. Never use attack or mine unless explicitly asked.', object({
    command: { type: 'string', enum: ['walk', 'turn', 'jump', 'use', 'attack', 'mine_target', 'stop'] },
    direction: { type: ['string', 'null'], enum: ['forward', 'backward', 'left', 'right', null] },
    duration_ms: { type: ['integer', 'null'], minimum: 100, maximum: 10000 },
    yaw: { type: ['number', 'null'], minimum: -180, maximum: 180 },
    pitch: { type: ['number', 'null'], minimum: -90, maximum: 90 }
  })),
  define('inspect_surroundings', 'Get a compact current world-state snapshot.', object({})),
  define('inspect_inventory', 'Get inventory items and free slots.', object({})),
  define('look_at', 'Turn to look at a world position.', object({ target: position })),
  define('move_to', 'Navigate to exact coordinates with a bounded pathfinding action.', object({ position, timeout_ms: { type: ['integer', 'null'] } })),
  define('move_near', 'Navigate within a radius of coordinates.', object({ position, radius: { type: 'number', minimum: 0 }, timeout_ms: { type: ['integer', 'null'] } })),
  define('follow_player', 'Continuously follow a visible moving player.', object({ username: { type: 'string', minLength: 1 } })),
  define('stop_following', 'Stop following a player and cancel navigation.', object({})),
  define('find_block', 'Find the nearest named block within a bounded radius.', object({ block: { type: 'string' }, radius: { type: ['integer', 'null'] } })),
  define('mine_block', 'Navigate to and mine one block by name or coordinates.', object({ block: { type: ['string', 'null'] }, position: nullablePosition })),
  define('collect_resource', 'Gather a target amount of a resource using bounded locate, navigate, mine, and pickup behavior.', object({ resource: { type: 'string' }, amount: { type: 'integer', minimum: 1, maximum: 64 } })),
  define('pickup_items', 'Walk to nearby dropped item entities.', object({ radius: { type: ['integer', 'null'] } })),
  define('craft_item', 'Craft an item using inventory or a nearby crafting table.', object({ item: { type: 'string' }, amount: { type: 'integer', minimum: 1, maximum: 64 } })),
  define('eat_best_food', 'Eat the best known food in inventory when hungry.', object({})),
  define('equip_item', 'Equip an inventory item.', object({ item: { type: 'string' }, destination: { type: ['string', 'null'], enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet', null] } })),
  define('attack_entity', 'Attack a visible entity by its perceived ID, respecting server rules and health.', object({ entity_id: { type: 'string' } })),
  define('attack_nearest_hostile', 'Defend against the closest hostile mob.', object({})),
  define('flee', 'Run away from a visible threat by perceived entity ID.', object({ threat_id: { type: 'string' } })),
  define('place_block', 'Place a block item at coordinates, optionally against a specific supporting block.', object({ item: { type: 'string' }, position, against: nullablePosition })),
  define('sleep', 'Find and sleep in a nearby bed when possible.', object({})),
  define('inspect_container', 'Inspect a chest, barrel, or other supported container.', object({ position })),
  define('deposit_item', 'Deposit an inventory item into a container.', object({ position, item: { type: 'string' }, amount: { type: 'integer', minimum: 1, maximum: 64 } })),
  define('withdraw_item', 'Withdraw an item from a container.', object({ position, item: { type: 'string' }, amount: { type: 'integer', minimum: 1, maximum: 64 } })),
  define('smelt_item', 'Smelt items in a nearby or specified furnace.', object({ input: { type: 'string' }, fuel: { type: ['string', 'null'] }, amount: { type: 'integer', minimum: 1, maximum: 64 }, furnace_position: nullablePosition })),
  define('say', 'Say a short message in Minecraft text chat.', object({ message: { type: 'string', minLength: 1, maxLength: 240 } })),
  define('remember_location', 'Save a named location only for the current server and dimension.', object({ name: { type: 'string' }, description: { type: 'string' }, importance: { type: 'number', minimum: 0, maximum: 1 } })),
  define('recall_location', 'Recall a named location from the current server and dimension.', object({ name: { type: 'string' } })),
  define('set_goal', 'Create a persistent global or current-server goal.', object({ description: { type: 'string' }, priority: { type: 'integer', minimum: 1, maximum: 100 }, scope: { type: 'string', enum: ['global', 'server'] }, notes: { type: 'string' } })),
  define('complete_goal', 'Mark a goal completed after its outcome is verified.', object({ id: { type: 'string' }, notes: { type: 'string' } })),
  define('list_goals', 'List active goals visible in the current server context.', object({})),
  define('remember_lesson', 'Store a durable general or current-server lesson.', object({ content: { type: 'string' }, scope: { type: 'string', enum: ['global', 'server'] }, importance: { type: 'number', minimum: 0, maximum: 1 } })),
  define('inspect_server_capabilities', 'Inspect generic and server-specific semantic capabilities.', object({})),
  define('server_action', 'Invoke a profile-defined semantic server action such as inspect_market.', object({ action: { type: 'string' }, arguments: object({}) }))
];
