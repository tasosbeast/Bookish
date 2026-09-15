export const CANONICAL_GENRE_SLUGS = new Set([
  'fiction',
  'classics',
  'literary-fiction',
  'historical-fiction',
  'contemporary',
  'adventure',
  'romance',
  'mystery',
  'thriller',
  'crime',
  'horror',
  'fantasy',
  'epic-fantasy',
  'urban-fantasy',
  'magical-realism',
  'science-fiction',
  'dystopian',
  'space-opera',
  'young-adult',
  'children',
  'biography',
  'memoir',
  'history',
  'true-crime',
  'science',
  'psychology',
  'philosophy',
  'politics',
  'economics',
  'business',
  'self-help',
  'religion-spirituality',
  'travel',
  'humor',
  'essays',
  'poetry',
  'drama',
]);

function normalizeCategoryText(cat) {
  if (!cat) return '';
  if (typeof cat === 'string') return cat.toLowerCase();
  const parts = [];
  if (cat.description) parts.push(cat.description);
  if (cat.catUri) parts.push(cat.catUri);
  if (cat.menuText) parts.push(cat.menuText);
  return parts.join(' ').toLowerCase();
}

export function mapCategoryStringToGenres(text) {
  const matched = [];

  // Specific speculative / fiction subgenres
  if (/\bspace\s*opera\b/.test(text)) {
    matched.push('space-opera', 'science-fiction');
  } else if (/\bdystop(?:ian|ia)\b|\bpost[- ]apocalyptic\b/.test(text)) {
    matched.push('dystopian', 'science-fiction');
  } else if (/\bscience\s*fiction\b|\bsci[- ]fi\b/.test(text)) {
    matched.push('science-fiction');
  }

  if (/\bepic\s*fantasy\b|\bhigh\s*fantasy\b/.test(text)) {
    matched.push('epic-fantasy', 'fantasy');
  } else if (/\burban\s*fantasy\b|\bparanormal\b/.test(text)) {
    matched.push('urban-fantasy', 'fantasy');
  } else if (/\bmagical\s*realism\b/.test(text)) {
    matched.push('magical-realism', 'fantasy');
  } else if (/\bfantasy\b/.test(text)) {
    matched.push('fantasy');
  }

  // Fiction types
  if (/\bhistorical\s*fiction\b|\bhistorical\b.*\bfiction\b/.test(text)) {
    matched.push('historical-fiction');
  }
  if (/\bliterary\s*fiction\b|\bliterary\b.*\bfiction\b/.test(text)) {
    matched.push('literary-fiction');
  }
  if (/\bcontemporary\b/.test(text)) {
    matched.push('contemporary');
  }
  if (/\bromance\b|\bromantic\b/.test(text)) {
    matched.push('romance');
  }
  if (/\bmystery\b|\bdetective\b|\bwhodunit\b/.test(text)) {
    matched.push('mystery');
  }
  if (/\bthriller\b|\bsuspense\b|\bpsychological\s*thriller\b/.test(text)) {
    matched.push('thriller');
  }
  if (/\btrue\s*crime\b/.test(text)) {
    matched.push('true-crime');
  } else if (/\bcrime\b|\bnoir\b/.test(text)) {
    matched.push('crime');
  }
  if (/\bhorror\b|\bghost\b|\bsupernatural\s*horror\b/.test(text)) {
    matched.push('horror');
  }
  if (/\bclassics?\b|\bclassical\s*literature\b/.test(text)) {
    matched.push('classics');
  }
  if (/\baction\s*&\s*adventure\b|\badventure\b/.test(text)) {
    matched.push('adventure');
  }

  // Audience
  if (/\byoung\s*adult\b|\bya\b|\bteen\b/.test(text)) {
    matched.push('young-adult');
  }
  if (/\bchildren\b|\bjuvenile\b|\bmiddle\s*grade\b/.test(text)) {
    matched.push('children');
  }

  // Nonfiction genres
  if (/\bmemoir\b|\bautobiograph\w*\b/.test(text)) {
    matched.push('memoir');
  }
  if (/\bbiograph\w*\b/.test(text)) {
    matched.push('biography');
  }
  if (/\bhistory\b|\bhistorical\b/.test(text) && !matched.includes('historical-fiction')) {
    matched.push('history');
  }
  if (/\bscience\b|\bnature\b|\bastronomy\b|\bphysics\b|\bbiology\b/.test(text) && !matched.includes('science-fiction')) {
    matched.push('science');
  }
  if (/\bpsychology\b|\bcognitive\b|\bmental\s*health\b/.test(text)) {
    matched.push('psychology');
  }
  if (/\bphilosophy\b|\bethics\b/.test(text)) {
    matched.push('philosophy');
  }
  if (/\bpolitics\b|\bpolitical\s*science\b|\bgovernment\b/.test(text)) {
    matched.push('politics');
  }
  if (/\beconomics\b|\beconomy\b/.test(text)) {
    matched.push('economics');
  }
  if (/\bbusiness\b|\bmanagement\b|\bleadership\b/.test(text)) {
    matched.push('business');
  }
  if (/\bself[- ]help\b|\bpersonal\s*growth\b/.test(text)) {
    matched.push('self-help');
  }
  if (/\breligion\b|\bspirituality\b|\btheology\b/.test(text)) {
    matched.push('religion-spirituality');
  }
  if (/\btravel\b|\bexploration\b/.test(text)) {
    matched.push('travel');
  }
  if (/\bhumor\b|\bcomedy\b|\bsatire\b/.test(text)) {
    matched.push('humor');
  }
  if (/\bessays\b|\bliterary\s*collections?\b/.test(text)) {
    matched.push('essays');
  }
  if (/\bpoetry\b|\bpoems?\b/.test(text)) {
    matched.push('poetry');
  }
  if (/\bdrama\b|\bplays?\b|\btheater\b/.test(text)) {
    matched.push('drama');
  }

  // General fallback fiction
  if (matched.length === 0 && /\bfiction\b/.test(text)) {
    matched.push('fiction');
  }

  return matched;
}

export function mapPrhCategoriesToGenres(categories) {
  if (!categories || !Array.isArray(categories) || categories.length === 0) {
    return [];
  }

  const collected = [];
  for (const cat of categories) {
    const text = normalizeCategoryText(cat);
    if (!text) continue;
    const slugs = mapCategoryStringToGenres(text);
    for (const slug of slugs) {
      if (CANONICAL_GENRE_SLUGS.has(slug) && !collected.includes(slug)) {
        collected.push(slug);
        if (collected.length >= 3) break;
      }
    }
    if (collected.length >= 3) break;
  }

  return collected.slice(0, 3);
}
