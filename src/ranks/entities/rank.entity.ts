import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Regiment } from '../../regiments/entities/regiment.entity';

/** Editable rank ladder (lookup table, per regiment). */
@Entity('ranks')
@Index(['regimentId', 'name'], { unique: true })
@Index(['regimentId', 'precedence'], { unique: true })
export class Rank {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 36 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Column({ type: 'varchar', length: 60 })
  name: string;

  @Column({ type: 'tinyint', unsigned: true, default: 0 })
  chevrons: number;

  @Column({ type: 'int' })
  precedence: number;

  @Column({ type: 'varchar', length: 80, nullable: true })
  discordRoleName: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  discordRoleId: string | null;

  @Column({ default: false })
  linked: boolean;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}
