export const CATEGORIES = [
  "furniture",
  "clothing",
  "food",
  "services",
  "electronics",
  "other",
] as const;

export const LISTING_STATUSES = ["active", "sold", "flagged", "removed"] as const;

export type Category = (typeof CATEGORIES)[number];
export type SourceChannel = "web" | "call" | "ussd";
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export type Listing = {
  id: string;
  item: string;
  category: Category;
  price: number | null;
  condition: string;
  location: string;
  contact: string;
  source_channel: SourceChannel;
  audio_url: string;
  narration_url: string;
  photo_url: string;
  extra_notes: string;
  status: ListingStatus;
  created_at: string;
};

export type CreateListingInput = Partial<
  Pick<
    Listing,
    | "item"
    | "category"
    | "condition"
    | "location"
    | "contact"
    | "source_channel"
    | "audio_url"
    | "narration_url"
    | "photo_url"
    | "extra_notes"
  >
> & {
  price?: number | string | null;
};

export type ListingPatch = Partial<
  Pick<
    Listing,
    | "item"
    | "category"
    | "condition"
    | "location"
    | "contact"
    | "audio_url"
    | "narration_url"
    | "photo_url"
    | "extra_notes"
    | "status"
  >
> & {
  price?: number | string | null;
};

function asCategory(value: unknown): Category {
  return CATEGORIES.includes(value as Category) ? (value as Category) : "other";
}

function asPrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asSourceChannel(value: unknown): SourceChannel {
  return value === "call" || value === "ussd" ? value : "web";
}

function isListingStatus(value: unknown): value is ListingStatus {
  return LISTING_STATUSES.includes(value as ListingStatus);
}

const seedTime = Date.now();

const listings: Listing[] = [
  {
    id: "demo-1",
    item: "Meza ya mbao, hali nzuri",
    category: "furniture",
    price: 3500,
    condition: "used",
    location: "Kawangware",
    contact: "0712000001",
    source_channel: "web",
    audio_url: "",
    narration_url: "",
    photo_url: "",
    extra_notes: "",
    status: "active",
    created_at: new Date(seedTime - 1000 * 60 * 45).toISOString(),
  },
  {
    id: "demo-2",
    item: "Shati mpya, size M",
    category: "clothing",
    price: 800,
    condition: "new",
    location: "Eastleigh",
    contact: "0712000002",
    source_channel: "web",
    audio_url: "",
    narration_url: "",
    photo_url: "",
    extra_notes: "",
    status: "active",
    created_at: new Date(seedTime - 1000 * 60 * 20).toISOString(),
  },
  {
    id: "demo-3",
    item: "Fundi umeme — wiring na sockets",
    category: "services",
    price: 1500,
    condition: "",
    location: "Kayole",
    contact: "0712000003",
    source_channel: "web",
    audio_url: "",
    narration_url: "",
    photo_url: "",
    extra_notes: "Bei ni kwa job ndogo ndani ya Kayole.",
    status: "active",
    created_at: new Date(seedTime - 1000 * 60 * 8).toISOString(),
  },
  {
    id: "demo-4",
    item: "Mboga fresh — sukuma, nyanya, kitungu",
    category: "food",
    price: 50,
    condition: "new",
    location: "Githurai",
    contact: "0712000004",
    source_channel: "ussd",
    audio_url: "",
    narration_url: "",
    photo_url: "",
    extra_notes: "Seeded as USSD so the feed can show mixed channels.",
    status: "active",
    created_at: new Date(seedTime - 1000 * 60 * 60).toISOString(),
  },
  {
    id: "demo-5",
    item: "Radio ya nyumbani",
    category: "electronics",
    price: 2500,
    condition: "used",
    location: "Embakasi",
    contact: "0712000005",
    source_channel: "web",
    audio_url: "",
    narration_url: "",
    photo_url: "",
    extra_notes: "",
    status: "active",
    created_at: new Date(seedTime - 1000 * 60 * 90).toISOString(),
  },
  {
    id: "demo-6",
    item: "Fundi welding — milango na grills",
    category: "services",
    price: 4000,
    condition: "",
    location: "Kariobangi",
    contact: "0712000006",
    source_channel: "call",
    audio_url: "",
    narration_url: "",
    photo_url: "",
    extra_notes: "Seeded as a voice call so the feed can show mixed channels.",
    status: "active",
    created_at: new Date(seedTime - 1000 * 60 * 35).toISOString(),
  },
  {
    id: "demo-7",
    item: "Kitenge dress mpya",
    category: "clothing",
    price: 1200,
    condition: "new",
    location: "Toi Market",
    contact: "0712000007",
    source_channel: "ussd",
    audio_url: "",
    narration_url: "",
    photo_url: "",
    extra_notes: "Seeded through the USSD flow.",
    status: "active",
    created_at: new Date(seedTime - 1000 * 60 * 120).toISOString(),
  },
];

function newestFirst(rows: Listing[]): Listing[] {
  return [...rows].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export const store = {
  list(): Listing[] {
    return newestFirst(listings.filter((listing) => listing.status !== "removed"));
  },

  get(id: string): Listing | undefined {
    return listings.find((listing) => listing.id === id);
  },

  create(input: CreateListingInput = {}): Listing {
    const listing: Listing = {
      id: `listing-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      item: asString(input.item),
      category: asCategory(input.category),
      price: asPrice(input.price),
      condition: asString(input.condition),
      location: asString(input.location),
      contact: asString(input.contact),
      source_channel: asSourceChannel(input.source_channel),
      audio_url: asString(input.audio_url),
      narration_url: asString(input.narration_url),
      photo_url: asString(input.photo_url),
      extra_notes: asString(input.extra_notes),
      status: "active",
      created_at: new Date().toISOString(),
    };
    listings.push(listing);
    return listing;
  },

  patch(id: string, changes: ListingPatch = {}): Listing | undefined {
    const listing = listings.find((candidate) => candidate.id === id);
    if (!listing) return undefined;

    if (typeof changes.item === "string") listing.item = changes.item.trim();
    if (changes.category !== undefined) listing.category = asCategory(changes.category);
    if (changes.price !== undefined) listing.price = asPrice(changes.price);
    if (typeof changes.condition === "string") listing.condition = changes.condition.trim();
    if (typeof changes.location === "string") listing.location = changes.location.trim();
    if (typeof changes.contact === "string") listing.contact = changes.contact.trim();
    if (typeof changes.audio_url === "string") listing.audio_url = changes.audio_url.trim();
    if (typeof changes.narration_url === "string") {
      listing.narration_url = changes.narration_url.trim();
    }
    if (typeof changes.photo_url === "string") listing.photo_url = changes.photo_url.trim();
    if (typeof changes.extra_notes === "string") {
      listing.extra_notes = changes.extra_notes.trim();
    }
    if (isListingStatus(changes.status)) listing.status = changes.status;

    return listing;
  },

  count(): number {
    return listings.length;
  },
};
