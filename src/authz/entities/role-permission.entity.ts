import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { ShortIdEntity } from '../../common/ids/short-id-entity.base';
import { MemberRole } from '../../common/enums';
import { Regiment } from '../../regiments/entities/regiment.entity';

/**
 * Authorization matrix — capability × role booleans, per regiment.
 * Source of truth for capability checks (stricter than the coarse isAdmin tier).
 */
@Entity('role_permissions')
@Index(['regimentId', 'role', 'capability'], { unique: true })
export class RolePermission extends ShortIdEntity {
  @Column({ type: 'char', length: 12 })
  regimentId: string;

  @ManyToOne(() => Regiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'regiment_id' })
  regiment?: Regiment;

  @Column({ type: 'enum', enum: MemberRole })
  role: MemberRole;

  @Column({ type: 'varchar', length: 60 })
  capability: string;

  @Column({ default: false })
  granted: boolean;
}
