import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Member } from '../../members/entities/member.entity';
import { GalleryItem } from './gallery-item.entity';

/** Junction: per-member likes (the source for the likes count). */
@Entity('gallery_likes')
export class GalleryLike {
  @PrimaryColumn({ type: 'char', length: 12 })
  galleryItemId: string;

  @ManyToOne(() => GalleryItem, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'gallery_item_id' })
  galleryItem?: GalleryItem;

  @Index()
  @PrimaryColumn({ type: 'char', length: 12 })
  memberId: string;

  @ManyToOne(() => Member, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'member_id' })
  member?: Member;

  @Column({ type: 'datetime', precision: 6 })
  likedAt: Date;
}
