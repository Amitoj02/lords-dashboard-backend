import { Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Member } from '../../members/entities/member.entity';
import { GalleryItem } from './gallery-item.entity';

/** Junction: members tagged in a gallery item. */
@Entity('gallery_tagged_members')
export class GalleryTaggedMember {
  @PrimaryColumn({ type: 'char', length: 36 })
  galleryItemId: string;

  @ManyToOne(() => GalleryItem, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'gallery_item_id' })
  galleryItem?: GalleryItem;

  @Index()
  @PrimaryColumn({ type: 'char', length: 36 })
  memberId: string;

  @ManyToOne(() => Member, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'member_id' })
  member?: Member;
}
