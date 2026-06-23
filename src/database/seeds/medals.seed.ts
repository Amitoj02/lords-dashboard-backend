import { DataSource } from 'typeorm';
import { MedalRibbon } from '../../common/enums';
import { Medal } from '../../medals/entities/medal.entity';
import { ensure, REGIMENT_ID } from './seed.util';

const MEDALS = [
  {
    title: 'Distinguished Service Cross',
    glyph: 'D',
    ribbon: MedalRibbon.Gold,
    description: 'Awarded for conspicuous gallantry and leadership in the line.',
    precedence: 1,
  },
  {
    title: 'Campaign Medal',
    glyph: 'C',
    ribbon: MedalRibbon.Blue,
    description: 'Awarded for participation in a full regiment campaign.',
    precedence: 2,
  },
  {
    title: "Marksman's Cross",
    glyph: 'M',
    ribbon: MedalRibbon.Green,
    description: 'Top 5% accuracy across three or more events.',
    precedence: 3,
  },
  {
    title: 'Medal of Valor',
    glyph: 'V',
    ribbon: MedalRibbon.Red,
    description: 'Awarded for exceptional bravery under fire.',
    precedence: 4,
  },
  {
    title: "Founder's Ribbon",
    glyph: 'F',
    ribbon: MedalRibbon.Tricolor,
    description: 'Held by founding members of the regiment.',
    precedence: 5,
  },
];

export async function seedMedals(ds: DataSource): Promise<void> {
  const repo = ds.getRepository(Medal);
  for (const medal of MEDALS) {
    await ensure(
      repo,
      { regimentId: REGIMENT_ID, title: medal.title },
      {
        glyph: medal.glyph,
        ribbon: medal.ribbon,
        description: medal.description,
        precedence: medal.precedence,
        linked: false,
      },
    );
  }
}
