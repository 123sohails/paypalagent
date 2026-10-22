export type Product = {
  id: string;
  name: string;
  description: string;
  merchantId: string;
  merchantName: string;
  amountMinor: number;
  currency: string;
  imageUrl: string;
};

export const catalog: Product[] = [
  {
    id: "headphones-001",
    name: "Studio Wireless Headphones",
    description: "Over-ear noise cancelling headphones with 30-hour battery life.",
    merchantId: "soundhouse",
    merchantName: "SoundHouse",
    amountMinor: 12999,
    currency: "USD",
    imageUrl: "https://images.unsplash.com/photo-1508997449629-303059a039c0?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "kettle-002",
    name: "Precision Pour-Over Kettle",
    description: "Temperature-controlled stainless steel kettle for better coffee.",
    merchantId: "dailybrew",
    merchantName: "Daily Brew",
    amountMinor: 8499,
    currency: "USD",
    imageUrl: "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "lamp-003",
    name: "Arc Table Lamp",
    description: "Minimal dimmable desk lamp with a warm, focused glow.",
    merchantId: "formandfunction",
    merchantName: "Form & Function",
    amountMinor: 6799,
    currency: "USD",
    imageUrl: "https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=900&q=85",
  },
  {
    id: "backpack-004",
    name: "Everyday Commuter Pack",
    description: "Weather-resistant 20L backpack with a padded laptop sleeve.",
    merchantId: "trailgoods",
    merchantName: "Trail Goods",
    amountMinor: 9499,
    currency: "USD",
    imageUrl: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=85",
  },
];

export function searchCatalog(query: string): Product[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return catalog
    .map((product) => ({
      product,
      score: terms.reduce(
        (score, term) =>
          score +
          Number(product.name.toLowerCase().includes(term)) * 3 +
          Number(product.description.toLowerCase().includes(term)) +
          Number(product.merchantName.toLowerCase().includes(term)),
        0,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ product }) => product);
}
