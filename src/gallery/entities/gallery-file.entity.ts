import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { GalleryMediaType } from '../../common/enums';
import { GalleryItem } from './gallery-item.entity';

/** An individual file within a multi-file gallery submission. */
@Entity('gallery_files')
export class GalleryFile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 36 })
  galleryItemId: string;

  @ManyToOne(() => GalleryItem, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'gallery_item_id' })
  galleryItem?: GalleryItem;

  @Column({ type: 'varchar', length: 255 })
  fileName: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  url: string | null;

  @Column({ type: 'enum', enum: GalleryMediaType })
  mediaType: GalleryMediaType;

  @Column({ type: 'bigint', unsigned: true, nullable: true })
  sizeBytes: string | null;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ type: 'int', nullable: true })
  durationSeconds: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  caption: string | null;

  @Column({ type: 'char', length: 7, nullable: true })
  thumbnailColor: string | null;
}
