import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/** Query params for GET /api/notifications (paginated, most recent first). */
export class NotificationQueryDto extends PaginationQueryDto {}
