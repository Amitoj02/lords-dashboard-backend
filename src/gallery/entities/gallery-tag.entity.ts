import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { GalleryItem } from './gallery-item.entity';

/** Junction: free-form tags on a gallery item (mirrors event_tags). */
@Entity('gallery_tags')
export class GalleryTag {
  @PrimaryColumn({ type: 'char', length: 36 })
  galleryItemId: string;

  @ManyToOne(() => GalleryItem, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'gallery_item_id' })
  galleryItem?: GalleryItem;

  @PrimaryColumn({ length: 40 })
  tag: string;
}
