import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const neuRoot = process.argv[2] || join(fileURLToPath(root), 'temp', 'neu-repo');
const neuItemsDirectory = join(neuRoot, 'items');
const neuConstantsDirectory = join(neuRoot, 'constants');
const rarityOrder = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC', 'SPECIAL', 'VERY_SPECIAL'];
const rarityRank = Object.fromEntries(rarityOrder.map((rarity, index) => [rarity, index]));
const petRarityIndex = { COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4, MYTHIC: 5 };

const [misc, petConstants, petNumbers, shardConstants, oldPetUpgrades, oldStrandedAccessories, officialItemsPayload, collectionPayload] = await Promise.all([
  readJson(join(neuConstantsDirectory, 'misc.json')),
  readJson(join(neuConstantsDirectory, 'pets.json')),
  readJson(join(neuConstantsDirectory, 'petnums.json')),
  readJson(join(neuConstantsDirectory, 'attribute_shards.json')),
  readJson(new URL('data/pet-upgrades.json', root)),
  readJson(new URL('data/accessories.json', root)),
  fetchJson('https://api.hypixel.net/v2/resources/skyblock/items'),
  fetchJson('https://api.hypixel.net/v2/resources/skyblock/collections'),
]);

const neuFiles = new Set(await readdir(neuItemsDirectory));
const officialItems = new Map((officialItemsPayload.items || []).map(item => [item.id, item]));

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function readNeuItem(id) {
  const filename = `${id}.json`;
  return neuFiles.has(filename) ? readJson(join(neuItemsDirectory, filename)) : null;
}

const clean = value => String(value || '').replace(/(?:Ã‚)?Â§[0-9A-FK-OR]/gi, '').replace(/§[0-9A-FK-OR]/gi, '').trim();
const titleCase = value => String(value || '').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());
const parseIngredient = value => {
  if (typeof value !== 'string') return null;
  const split = value.lastIndexOf(':');
  if (split < 1) return null;
  const amount = Number(value.slice(split + 1));
  return Number.isFinite(amount) && amount > 0 ? { id: value.slice(0, split), amount } : null;
};
const mergeRequirements = values => {
  const totals = new Map();
  for (const value of values) {
    const ingredient = typeof value === 'string' ? parseIngredient(value) : value;
    if (!ingredient || typeof ingredient.id !== 'string' || !ingredient.id || !Number.isFinite(ingredient.amount) || ingredient.amount <= 0) continue;
    totals.set(ingredient.id, (totals.get(ingredient.id) || 0) + ingredient.amount);
  }
  return [...totals].map(([id, amount]) => ({ id, amount }));
};
const ingredientLabel = id => titleCase(id).replace(/^Enchanted /, 'Enchanted ');
const materialSummary = requirements => requirements.slice(0, 3).map(item => `${item.amount.toLocaleString('en-US')} ${ingredientLabel(item.id)}`).join(' + ')
  + (requirements.length > 3 ? ` + ${requirements.length - 3} more` : '');

function textureUrlFromValue(value) {
  if (!value) return null;
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    return payload.textures?.SKIN?.url?.replace('http:', 'https:') || null;
  } catch {
    return null;
  }
}

function textureUrlFromNeu(item) {
  const value = item?.nbttag?.match(/Value:\"([^\"]+)\"/)?.[1];
  return textureUrlFromValue(value);
}

function recipeRequirements(item) {
  const recipe = item?.recipe || item?.recipes?.find(candidate => candidate.type === 'crafting');
  if (!recipe) return [];
  return mergeRequirements(Object.values(recipe));
}

class DisjointSet {
  constructor(values) {
    this.parent = new Map(values.map(value => [value, value]));
  }
  find(value) {
    const parent = this.parent.get(value);
    if (parent === value) return value;
    const rootValue = this.find(parent);
    this.parent.set(value, rootValue);
    return rootValue;
  }
  union(left, right) {
    const leftRoot = this.find(left), rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

async function buildAccessories() {
  const dynamicMaxRarity = { BOOK_OF_PROGRESSION: 'MYTHIC', PULSE_RING: 'LEGENDARY', RUNEBOOK: 'LEGENDARY' };
  const ignored = new Set(misc.ignored_talisman || []);
  const collapsedInto = new Map([
    ['PARTY_HAT_CRAB_ANIMATED', 'PARTY_HAT_CRAB'],
    ['PARTY_HAT_SLOTH', 'PARTY_HAT_CRAB'],
  ]);
  const candidates = (officialItemsPayload.items || []).filter(item => item.category === 'ACCESSORY' && !ignored.has(item.id));
  const candidateIds = new Set(candidates.map(item => item.id));
  const canonicalIds = candidates.map(item => collapsedInto.get(item.id) || item.id).filter((id, index, values) => values.indexOf(id) === index);
  const canonicalSet = new Set(canonicalIds);
  const families = new DisjointSet(canonicalIds);
  for (const [from, upgrades] of Object.entries(misc.talisman_upgrades || {})) {
    const canonicalFrom = collapsedInto.get(from) || from;
    if (!canonicalSet.has(canonicalFrom)) continue;
    for (const upgrade of upgrades) {
      const canonicalUpgrade = collapsedInto.get(upgrade) || upgrade;
      if (canonicalSet.has(canonicalUpgrade)) families.union(canonicalFrom, canonicalUpgrade);
    }
  }

  const existingProfileIds = new Map((oldStrandedAccessories.accessories || []).map(item => [item.id, item.profileIds || [item.id]]));
  const celebrationAliases = new Set(['PARTY_HAT_CRAB', 'PARTY_HAT_CRAB_ANIMATED', 'PARTY_HAT_SLOTH']);
  for (const [id, upgrades] of Object.entries(misc.talisman_upgrades || {})) {
    if (/^(?:PARTY_HAT_|BALLOON_HAT_|CAKE_HAT_)/.test(id)) celebrationAliases.add(id);
    for (const upgrade of upgrades) if (/^(?:PARTY_HAT_|BALLOON_HAT_|CAKE_HAT_)/.test(upgrade)) celebrationAliases.add(upgrade);
  }

  const enriched = [];
  for (const id of canonicalIds) {
    const official = officialItems.get(id);
    const neu = await readNeuItem(id);
    const loreRarity = [...(neu?.lore || [])].reverse().map(clean).join(' ').match(/(VERY SPECIAL|SPECIAL|MYTHIC|LEGENDARY|EPIC|RARE|UNCOMMON|COMMON)\s+(?:[A-Z]+\s+)?(?:ACCESSORY|HATC?CESSORY)/i)?.[1]?.replace(' ', '_').toUpperCase();
    const rarity = official?.tier || loreRarity;
    if (!rarityRank.hasOwnProperty(rarity)) throw new Error(`Could not determine accessory rarity for ${id}`);
    const rawRequirements = recipeRequirements(neu).filter(requirement => !candidateIds.has(requirement.id));
    const requirements = rawRequirements.map(requirement => ({ type: 'item', ...requirement }));
    const source = neu?.slayer_req ? 'Slayer'
      : requirements.length ? 'Crafting'
        : /rift/i.test(`${neu?.crafttext || ''} ${(neu?.info || []).join(' ')}`) ? 'Rift'
          : official?.soulbound ? 'Progression'
            : 'Economy';
    const profileIds = new Set([id, ...(existingProfileIds.get(id) || []).filter(alias => !candidateIds.has(alias))]);
    if (id === 'PARTY_HAT_CRAB') for (const alias of celebrationAliases) profileIds.add(alias);
    const route = requirements.length
      ? `Craft with ${materialSummary(requirements)}`
      : neu?.crafttext
        ? clean(neu.crafttext)
        : 'Obtain through Normal profile progression or the player economy';
    const fallbackTexture = textureUrlFromValue(official?.skin?.value) || textureUrlFromNeu(neu);
    enriched.push({
      id,
      name: id === 'PARTY_HAT_CRAB' ? 'Celebration Hat' : clean(official?.name) || clean(neu?.displayname) || titleCase(id),
      rarity,
      source,
      route,
      familyRoot: families.find(id),
      canRecombobulate: official?.can_recombobulate !== false,
      maxRarity: dynamicMaxRarity[id],
      requirements,
      profileIds: [...profileIds].sort(),
      fallbackTexture,
      fallbackTextureType: fallbackTexture ? 'head' : undefined,
      fallbackMaterial: official?.material,
    });
  }

  const grouped = Map.groupBy(enriched, item => item.familyRoot);
  const accessories = [];
  let order = 0;
  for (const [familyRoot, members] of [...grouped].sort(([, left], [, right]) => left[0].name.localeCompare(right[0].name))) {
    members.sort((left, right) => rarityRank[left.rarity] - rarityRank[right.rarity]
      || left.id.localeCompare(right.id, 'en', { numeric: true }));
    members.forEach((member, familyOrder) => {
      const item = {
        id: member.id,
        name: member.name,
        rarity: member.rarity,
        source: member.source,
        route: member.route,
        family: familyRoot,
        familyOrder,
        order: order++,
        canRecombobulate: member.canRecombobulate,
      };
      if (member.maxRarity) item.maxRarity = member.maxRarity;
      if (member.requirements.length) item.requirements = member.requirements;
      if (member.profileIds.length > 1) item.profileIds = member.profileIds;
      if (member.fallbackTexture) {
        item.fallbackTexture = member.fallbackTexture;
        item.fallbackTextureType = member.fallbackTextureType;
      }
      if (member.fallbackMaterial) item.fallbackMaterial = member.fallbackMaterial;
      accessories.push(item);
    });
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceSnapshot: 'Official Hypixel items API + NotEnoughUpdates repository',
    accessories,
    legacyAccessories: [],
    familyUpgrades: {},
  };
}

async function buildPets() {
  const pets = [], upgrades = {};
  for (const [id, rarities] of Object.entries(petNumbers).sort(([left], [right]) => left.localeCompare(right))) {
    const availableRarities = Object.keys(rarities).filter(rarity => Object.hasOwn(petRarityIndex, rarity));
    const targetRarity = availableRarities.sort((left, right) => petRarityIndex[left] - petRarityIndex[right]).at(-1);
    if (!targetRarity) continue;
    const maxLevel = Number(petConstants.custom_pet_leveling?.[id]?.max_level) || 100;
    const neu = await readNeuItem(`${id};${petRarityIndex[targetRarity]}`);
    pets.push({
      id,
      name: petConstants.id_to_display_name?.[id] || titleCase(id),
      targetRarity,
      maxLevel,
      texture: textureUrlFromNeu(neu),
      note: `${titleCase(petConstants.pet_types?.[id] || 'SkyBlock')} pet available on Normal profiles`,
    });

    const steps = [];
    for (let targetIndex = 1; targetIndex <= petRarityIndex[targetRarity]; targetIndex += 1) {
      const item = await readNeuItem(`${id};${targetIndex}`);
      const recipe = item?.recipes?.find(candidate => candidate.type === 'katgrade' && candidate.output === `${id};${targetIndex}`);
      if (!recipe) continue;
      steps.push({
        from: rarityOrder[targetIndex - 1],
        to: rarityOrder[targetIndex],
        coins: Number(recipe.coins) || 0,
        timeSeconds: Number(recipe.time) || 0,
        method: 'Kat',
        requirements: mergeRequirements(recipe.items || []),
      });
    }
    const existingSpecialSteps = oldPetUpgrades.upgrades?.[id] || [];
    for (const step of existingSpecialSteps) {
      if ((rarityRank[step.to] ?? -1) > (rarityRank[targetRarity] ?? -1)) continue;
      const index = steps.findIndex(candidate => candidate.from === step.from && candidate.to === step.to);
      if (index < 0) steps.push(step);
    }
    if (steps.length) upgrades[id] = steps.sort((left, right) => rarityRank[left.to] - rarityRank[right.to]);
  }
  return {
    pets: { version: 1, generatedAt: new Date().toISOString(), sourceSnapshot: 'NotEnoughUpdates pet data', pets },
    upgrades: { version: 1, generatedAt: new Date().toISOString(), sourceSnapshot: 'NotEnoughUpdates Kat recipes', upgrades },
  };
}

async function buildAttributes() {
  const attributes = [];
  for (const shard of shardConstants.attributes || []) {
    const neu = await readNeuItem(shard.internalName);
    const id = shard.bazaarName.replace(/^SHARD_/, '');
    const details = [shard.abilityName, shard.alignment ? `${shard.alignment} alignment` : null, shard.family?.length ? `${shard.family.join(', ')} family` : null].filter(Boolean).join(' · ');
    const item = { id, name: shard.displayName, rarity: shard.rarity, maxLevel: 10, note: details };
    const texture = textureUrlFromNeu(neu);
    if (texture) {
      item.fallbackTexture = texture;
      item.fallbackTextureType = 'head';
    }
    attributes.push(item);
  }
  attributes.sort((left, right) => rarityRank[left.rarity] - rarityRank[right.rarity] || left.name.localeCompare(right.name));
  return { version: 1, generatedAt: new Date().toISOString(), sourceSnapshot: 'NotEnoughUpdates Attribute Shards', maxLevel: 10, attributes };
}

function minionCategory(id) {
  if (['WHEAT', 'CARROT', 'POTATO', 'PUMPKIN', 'MELON', 'MUSHROOM', 'CACTUS', 'COCOA', 'SUGAR_CANE', 'NETHER_WARTS', 'CHICKEN', 'COW', 'PIG', 'SHEEP', 'RABBIT'].includes(id)) return 'Farming';
  if (['OAK', 'SPRUCE', 'BIRCH', 'DARK_OAK', 'ACACIA', 'JUNGLE', 'FLOWER', 'SUNFLOWER'].includes(id)) return 'Foraging';
  if (['FISHING', 'CLAY', 'LILY_PAD'].includes(id)) return 'Fishing';
  if (['ZOMBIE', 'SKELETON', 'CREEPER', 'SPIDER', 'CAVESPIDER', 'BLAZE', 'MAGMA_CUBE', 'ENDERMAN', 'GHAST', 'SLIME', 'REVENANT', 'TARANTULA', 'VOIDLING', 'INFERNO', 'VAMPIRE'].includes(id)) return 'Combat';
  return 'Mining';
}

function collectionUnlocks() {
  const unlocks = [];
  for (const category of Object.values(collectionPayload.collections || {})) {
    for (const [id, item] of Object.entries(category.items || {})) {
      for (const tier of item.tiers || []) {
        for (const unlock of tier.unlocks || []) unlocks.push({ text: clean(unlock).toLowerCase(), id, name: item.name, tier: tier.tier, amount: tier.amountRequired });
      }
    }
  }
  return unlocks;
}

async function buildMinions() {
  const knownUnlocks = collectionUnlocks(), minions = [];
  for (const [idWithSuffix, maxTier] of Object.entries(misc.minions || {}).sort(([left], [right]) => left.localeCompare(right))) {
    const id = idWithSuffix.replace(/_GENERATOR$/, '');
    const tiers = [];
    let name = `${titleCase(id)} Minion`, texture = null, unlock = null, unlockGate = null;
    for (let tier = 1; tier <= Number(maxTier); tier += 1) {
      const internalId = `${id}_GENERATOR_${tier}`, item = await readNeuItem(internalId);
      if (!item) continue;
      if (tier === 1) {
        name = clean(item.displayname).replace(/\s+[IVXLCDM]+$/, '') || name;
        texture = textureUrlFromNeu(item);
        unlock = item.crafttext ? clean(item.crafttext).replace(/^Requires:\s*/i, '') : null;
        if (item.slayer_req) {
          const match = String(item.slayer_req).match(/^(.+)_([0-9]+)$/);
          if (match) unlockGate = { type: 'slayer', id: match[1].toLowerCase(), name: `${titleCase(match[1])} Slayer`, level: Number(match[2]) };
        }
      }
      const requirements = recipeRequirements(item).filter(requirement => requirement.id !== `${id}_GENERATOR_${tier - 1}`);
      tiers.push({ tier, id: internalId, requirements });
    }
    if (!unlockGate) {
      const match = knownUnlocks.find(candidate => candidate.text.includes(`${name.toLowerCase()} recipes`));
      if (match) unlockGate = { type: 'collection', id: match.id, name: match.name, tier: match.tier, amount: match.amount };
    }
    if (id === 'FLOWER' && tiers[0]) tiers[0].acquisition = 'Buy Flower Minion I from the Dark Auction';
    if (id === 'SNOW' && tiers[0]) tiers[0].acquisition = 'Obtain Snow Minion I from Winter Gifts';
    const minion = { id, name, category: minionCategory(id), unlock, texture, tiers };
    if (unlockGate) minion.unlockGate = unlockGate;
    minions.push(minion);
  }
  return { version: 1, generatedAt: new Date().toISOString(), sourceSnapshot: 'NotEnoughUpdates minion recipes + Official Hypixel collections API', minions };
}

const [accessories, petCatalogs, attributes, minions] = await Promise.all([
  buildAccessories(),
  buildPets(),
  buildAttributes(),
  buildMinions(),
]);

await Promise.all([
  writeFile(new URL('data/normal-accessories.json', root), `${JSON.stringify(accessories, null, 2)}\n`),
  writeFile(new URL('data/normal-pets.json', root), `${JSON.stringify(petCatalogs.pets, null, 2)}\n`),
  writeFile(new URL('data/normal-pet-upgrades.json', root), `${JSON.stringify(petCatalogs.upgrades, null, 2)}\n`),
  writeFile(new URL('data/normal-attributes.json', root), `${JSON.stringify(attributes, null, 2)}\n`),
  writeFile(new URL('data/normal-minions.json', root), `${JSON.stringify(minions, null, 2)}\n`),
]);

console.log(`Normal catalogs: ${accessories.accessories.length} accessories in ${new Set(accessories.accessories.map(item => item.family)).size} families, ${petCatalogs.pets.pets.length} pets, ${attributes.attributes.length} attributes, ${minions.minions.length} minion families.`);
