import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Lookup of regiment accent colours (key → hex/label). */
@Entity('accent_tones')
export class AccentTone {
  @PrimaryColumn({ length: 20 })
  key: string;

  @Column({ type: 'varchar', length: 40 })
  label: string;

  @Column({ type: 'char', length: 7 })
  hex: string;

  @Column({ type: 'tinyint', unsigned: true })
  sortOrder: number;
}
