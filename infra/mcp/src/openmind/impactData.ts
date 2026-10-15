// OpenmindProjects impact data — static figures for the "Our Impact" (/give)
// surface. Ported from the web app's webmcp/lib/impactData.ts and
// impactTreasures.ts so the MCP impact tools return the same figures.
// Figures are static until a backend funding/outcome source is introduced.

export const IMPACT_UPDATED_AT = '2026-09-03T00:00:00.000Z';

export interface ImpactCause {
  id: string;
  name: string;
  location: { name: string; countryCode: string };
  shortDescription: string;
  themes: string[];
  sdgNumbers: number[];
  image: string;
  raised: number;
  goal: number;
  stats: { participants: number; trainers: number; volunteers: number };
  videoId?: string;
  learnMoreUrl?: string;
  updatedAt: string;
}

export interface ImpactSdg {
  number: number;
  title: string;
  description: string;
  badge: string;
}

export interface ImpactOverview {
  totalRaised: number;
  totalGoal: number;
  travelersAndDonors: number;
  sdgs: ImpactSdg[];
  partners: string[];
  updatedAt: string;
}

export interface ImpactStory {
  id: string;
  title: string;
  author: string;
  quote: string;
  body: string[];
  images: string[];
}

export interface ImpactTreasure {
  id: string;
  name: string;
  description: string;
  location: string;
  country: string;
  coordinates: { lat: number; lng: number };
  sdgGoal: number;
  sdgName: string;
  sdgDescription: string;
  difficulty: 'easy' | 'moderate' | 'challenging';
  emoji: string;
  xpReward: number;
  hint?: string;
  image?: string;
  active: boolean;
}

const IMPACT_CAUSES: ImpactCause[] = [
  {
    id: 'active-learning-camp',
    name: 'Active Learning Camp',
    location: { name: 'Nong Khai, Thailand', countryCode: 'TH' },
    shortDescription:
      'Support our active learning camps for underprivileged students in Southeast Asia, providing essential skills in English, IT, and critical thinking.',
    themes: ['Education', 'Global Goals', 'Train the Trainers'],
    sdgNumbers: [4],
    image:
      'https://openmindprojects.org/wp-content/uploads/2024/11/Camper-Wha-Wha-debating-health-in-English.jpg.webp',
    raised: 4679,
    goal: 26000,
    stats: { participants: 2000, trainers: 150, volunteers: 400 },
    videoId: '0F4blkzBmUo',
    updatedAt: IMPACT_UPDATED_AT,
  },
  {
    id: 'train-the-trainers',
    name: 'Train the Trainers Sponsorship Program',
    location: { name: 'Nong Khai, Thailand', countryCode: 'TH' },
    shortDescription:
      'Sponsor local educators and community leaders to become certified trainers, multiplying the impact of education across Southeast Asia.',
    themes: ['Train the Trainers', 'Education', 'Sponsorship'],
    sdgNumbers: [4, 8],
    image:
      'https://file.9o9.io/api/public/dl/sGoQ8rCa/home/rootmind/omt/projects/Learning-Center/train-the-trainers.JPG',
    raised: 9679,
    goal: 35000,
    stats: { participants: 500, trainers: 50, volunteers: 100 },
    videoId: 'W3Z50cUNYQg',
    learnMoreUrl: 'https://openskills.dev/ttt-dashboard',
    updatedAt: IMPACT_UPDATED_AT,
  },
  {
    id: 'bit-builders',
    name: 'Bit Builders: Building Futures',
    location: { name: 'Nong Khai, Thailand', countryCode: 'TH' },
    shortDescription:
      'Help us build and equip a micro-lab to give students hands-on experience with modern technology and foster innovation.',
    themes: ['Education', 'Micro-Lab', 'Global Goals'],
    sdgNumbers: [4, 10],
    image:
      'https://file.9o9.io/api/public/dl/5tAa1U6R/home/rootmind/omt/projects/disable-gilr-learn-code.webp',
    raised: 200,
    goal: 2500,
    stats: { participants: 50, trainers: 10, volunteers: 20 },
    videoId: 'Bwl_QA4_8LA',
    updatedAt: IMPACT_UPDATED_AT,
  },
  {
    id: 'shes-more',
    name: "She's More — Empowering Changemakers",
    location: { name: 'Southeast Asia', countryCode: 'TH' },
    shortDescription:
      'Empowering girls and women through education, technology, and economic opportunities to become changemakers.',
    themes: ['Women Empowerment', 'Education', 'Global Goals'],
    sdgNumbers: [5, 4],
    image:
      'https://file.9o9.io/api/public/dl/9u8iEzsa/home/rootmind/omt/projects/She-is-more/shere-is-more-tour.avif',
    raised: 579,
    goal: 6000,
    stats: { participants: 100, trainers: 15, volunteers: 30 },
    videoId: 'hvq1wyQDyf4',
    updatedAt: IMPACT_UPDATED_AT,
  },
];

const IMPACT_SDGS: ImpactSdg[] = [
  { number: 1, title: 'No Poverty', description: 'Through educating disadvantaged people in the poorest regions of Southeast Asia, we have empowered them with the skills needed to improve their lives.', badge: '10,000+ beneficiaries supported' },
  { number: 4, title: 'Quality Education', description: 'Hosting learning camps has given us the ability to provide rural and disabled students the knowledge and education they deserve. Teaching English and IT expands their opportunities.', badge: '32,000+ students educated' },
  { number: 5, title: 'Gender Equality', description: "Operating an extensive support, training, and consultation network for women of Thailand's rural villages, providing tools necessary to thrive.", badge: '500+ women trained' },
  { number: 8, title: 'Decent Work & Economic Growth', description: 'Running teacher training workshops in rural communities has led to creating proactive and confident lifelong learners.', badge: '250+ teachers empowered' },
  { number: 10, title: 'Reduced Inequalities', description: 'Investing in local development to empower men and women to achieve better and equal education and job opportunities.', badge: '600+ scholarships awarded' },
  { number: 13, title: 'Climate Action', description: 'Providing environmental education, creating awareness about climate change causes and effects and what must be done to combat it.', badge: '200+ mobile training camps' },
];

const IMPACT_PARTNERS: string[] = [
  'Tourism Authority of Thailand',
  'UNESCO',
  'CNN',
  'Rotary Club',
  'Lonely Planet',
  'TechSoup',
  'Social Impact Fund',
];

const IMPACT_STORIES: ImpactStory[] = [
  {
    id: 'luis-alberto-and-family',
    title: "Luis Alberto & Family's Story",
    author: 'Luis Alberto & Family',
    quote:
      'We had the opportunity to experience notable and unique tours... The canoeing in the middle of floating lotus flowers is one of them.',
    body: [
      'OpenmindProjects is an NGO that helps people to come out of poverty and illiteracy, and contribute to save nature in Thailand, but also in Laos, Cambodia and Nepal.',
      'Have you ever been surrounded by lotus flowers floating in the middle of a lake?',
      'That could become one of the excursions that you can take at a fair price. And the best way to do it is by booking an accommodation at the OpenmindProjects (OMP) centre in Nong Khai, Thailand.',
      'So did we: In March we visited OMP and we stayed at the organization\'s accommodation: Homing bungalows surrounding a patio shaded by mature trees and flowering plants.',
      'We were a group of 6 friends traveling the SouthEast Asian countries and we had the opportunity to experience notable and unique tours and excursions designed by OMP which likely have not been replicated by travelling agencies elsewhere... The canoeing in the middle of floating lotus flowers is one of them.',
    ],
    images: [
      'https://file.9o9.io/api/public/dl/gA4dlrEr/home/rootmind/omt/tours/traveler/1000031975.jpg',
    ],
  },
];

const IMPACT_TREASURES: ImpactTreasure[] = [
  {
    id: 'knowledge-key',
    name: 'The Knowledge Key',
    description: 'Hidden near the entrance of the Learning Center, this treasure represents the key to unlocking education for every child in Southeast Asia.',
    location: 'OMP Learning Center, Nong Khai',
    country: 'Thailand',
    coordinates: { lat: 17.878, lng: 102.741 },
    sdgGoal: 4,
    sdgName: 'Quality Education',
    sdgDescription: 'This learning center has educated over 32,000 students through active learning camps, English, and IT training.',
    difficulty: 'easy',
    emoji: '🔑',
    xpReward: 50,
    hint: 'Look where knowledge begins — near the welcome area.',
    image: 'https://file.9o9.io/api/public/dl/sGoQ8rCa/home/rootmind/omt/projects/Learning-Center/train-the-trainers.JPG',
    active: true,
  },
  {
    id: 'lotus-guardian',
    name: 'Lotus Guardian',
    description: 'At the serene lotus lake excursion point, this cache celebrates the beauty of nature conservation and sustainable tourism.',
    location: 'Lotus Lake, Nong Khai Province',
    country: 'Thailand',
    coordinates: { lat: 17.850, lng: 102.780 },
    sdgGoal: 13,
    sdgName: 'Climate Action',
    sdgDescription: 'Environmental education programs here teach locals and travelers about climate change and nature preservation.',
    difficulty: 'moderate',
    emoji: '🪷',
    xpReward: 75,
    hint: 'Where lotus flowers bloom, guardians watch from the shore.',
    image: 'https://file.9o9.io/api/public/dl/0-HVpmfn/home/rootmind/omt/tours/traveler/signal-2025-03-29-21-23-10-557.jpg',
    active: true,
  },
  {
    id: 'trainers-token',
    name: "Trainer's Token",
    description: 'Located at the Train the Trainers workshop space, this treasure honors every local educator who multiplies knowledge across communities.',
    location: 'TTT Workshop, Nong Khai',
    country: 'Thailand',
    coordinates: { lat: 17.875, lng: 102.745 },
    sdgGoal: 8,
    sdgName: 'Decent Work & Economic Growth',
    sdgDescription: 'The Train the Trainers program has empowered 250+ local teachers with modern pedagogical skills.',
    difficulty: 'easy',
    emoji: '🎓',
    xpReward: 50,
    hint: 'Where trainers gather to learn how to teach.',
    image: 'https://file.9o9.io/api/public/dl/sGoQ8rCa/home/rootmind/omt/projects/Learning-Center/train-the-trainers.JPG',
    active: true,
  },
  {
    id: 'empowerment-stone',
    name: 'Empowerment Stone',
    description: "At the She's More training site, this cache celebrates the strength and resilience of women building better futures for their families.",
    location: "She's More Training Site, Nong Khai",
    country: 'Thailand',
    coordinates: { lat: 17.882, lng: 102.738 },
    sdgGoal: 5,
    sdgName: 'Gender Equality',
    sdgDescription: 'Over 500 women have received training in technology, leadership, and economic empowerment through this program.',
    difficulty: 'moderate',
    emoji: '💎',
    xpReward: 75,
    hint: 'Strong foundations support strong women.',
    image: 'https://file.9o9.io/api/public/dl/9u8iEzsa/home/rootmind/omt/projects/She-is-more/shere-is-more-tour.avif',
    active: true,
  },
  {
    id: 'bit-builders-beacon',
    name: "Bit Builder's Beacon",
    description: 'At the micro-lab where young students learn to code, this beacon shines for the future of digital literacy in rural Thailand.',
    location: 'Bit Builders Micro-Lab, Nong Khai',
    country: 'Thailand',
    coordinates: { lat: 17.876, lng: 102.743 },
    sdgGoal: 10,
    sdgName: 'Reduced Inequalities',
    sdgDescription: 'The Bit Builders lab gives disabled and underprivileged students hands-on experience with technology, bridging the digital divide.',
    difficulty: 'easy',
    emoji: '💡',
    xpReward: 50,
    hint: 'Where bits become futures, and code becomes change.',
    image: 'https://file.9o9.io/api/public/dl/5tAa1U6R/home/rootmind/omt/projects/disable-gilr-learn-code.webp',
    active: true,
  },
];

export function getImpactOverview(): ImpactOverview {
  const totalRaised = IMPACT_CAUSES.reduce((sum, c) => sum + c.raised, 0);
  const totalGoal = IMPACT_CAUSES.reduce((sum, c) => sum + c.goal, 0);
  return {
    totalRaised,
    totalGoal,
    travelersAndDonors: 4000,
    sdgs: IMPACT_SDGS,
    partners: IMPACT_PARTNERS,
    updatedAt: IMPACT_UPDATED_AT,
  };
}

export function listImpactCauses(filter: { countryCode?: string; themes?: string[] } = {}): ImpactCause[] {
  return IMPACT_CAUSES.filter((cause) => {
    if (filter.countryCode && cause.location.countryCode !== filter.countryCode.toUpperCase()) return false;
    if (filter.themes && filter.themes.length > 0) {
      const wanted = filter.themes.map((t) => t.toLowerCase());
      const has = cause.themes.map((t) => t.toLowerCase());
      if (!wanted.some((w) => has.includes(w))) return false;
    }
    return true;
  });
}

export function getImpactCause(id: string): ImpactCause | undefined {
  return IMPACT_CAUSES.find((c) => c.id === id);
}

export function getImpactStories(): ImpactStory[] {
  return IMPACT_STORIES;
}

export function getActiveTreasures(): ImpactTreasure[] {
  return IMPACT_TREASURES.filter((t) => t.active);
}

export function getImpactTreasure(id: string): ImpactTreasure | undefined {
  return IMPACT_TREASURES.find((t) => t.id === id);
}
