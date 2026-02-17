"""DRF Serializers for drawings app."""
from rest_framework import serializers
from .models import Project, Sheet, JoinMark, AssetType, Asset, AdjustmentLog, ImportBatch, Link


class AssetTypeSerializer(serializers.ModelSerializer):
    class Meta:
        model = AssetType
        fields = ['id', 'name', 'icon_shape', 'custom_icon', 'color', 'size']


class JoinMarkSerializer(serializers.ModelSerializer):
    class Meta:
        model = JoinMark
        fields = ['id', 'sheet', 'x', 'y', 'reference_label', 'linked_mark']


class SheetSerializer(serializers.ModelSerializer):
    join_marks = JoinMarkSerializer(many=True, read_only=True)
    rendered_image_url = serializers.SerializerMethodField()

    class Meta:
        model = Sheet
        fields = [
            'id', 'project', 'name', 'pdf_file', 'page_number',
            'rendered_image', 'rendered_image_url', 'image_width', 'image_height',
            'cuts_json',
            'offset_x', 'offset_y', 'rotation', 'z_index',
            'join_marks', 'created_at'
        ]
        read_only_fields = ['project', 'rendered_image', 'image_width', 'image_height']

    def validate_cuts_json(self, value):
        if not isinstance(value, list):
            raise serializers.ValidationError("cuts_json must be a list")
        for i, cut in enumerate(value):
            if not isinstance(cut, dict):
                raise serializers.ValidationError(f"cuts_json[{i}] must be an object")
            for key in ('p1', 'p2'):
                if key not in cut:
                    raise serializers.ValidationError(f"cuts_json[{i}] missing '{key}'")
                pt = cut[key]
                if not isinstance(pt, dict) or 'x' not in pt or 'y' not in pt:
                    raise serializers.ValidationError(f"cuts_json[{i}].{key} must have x and y")
        return value

    def get_rendered_image_url(self, obj):
        if obj.rendered_image:
            request = self.context.get('request')
            if request:
                return request.build_absolute_uri(obj.rendered_image.url)
            return obj.rendered_image.url
        return None


class ImportBatchSerializer(serializers.ModelSerializer):
    class Meta:
        model = ImportBatch
        fields = ['id', 'project', 'filename', 'asset_count', 'created_at']
        read_only_fields = ['project']


class AssetSerializer(serializers.ModelSerializer):
    asset_type_data = AssetTypeSerializer(source='asset_type', read_only=True)
    current_x = serializers.FloatField(read_only=True)
    current_y = serializers.FloatField(read_only=True)
    delta_distance = serializers.FloatField(read_only=True)
    import_batch_name = serializers.CharField(source='import_batch.filename', read_only=True, default=None)

    class Meta:
        model = Asset
        fields = [
            'id', 'project', 'asset_type', 'asset_type_data', 'asset_id', 'name',
            'original_x', 'original_y', 'adjusted_x', 'adjusted_y',
            'current_x', 'current_y', 'is_adjusted', 'delta_distance',
            'import_batch', 'import_batch_name',
            'metadata', 'created_at', 'updated_at'
        ]
        read_only_fields = ['project', 'is_adjusted']


class AdjustmentLogSerializer(serializers.ModelSerializer):
    asset_id = serializers.CharField(source='asset.asset_id', read_only=True)

    class Meta:
        model = AdjustmentLog
        fields = [
            'id', 'asset', 'asset_id',
            'from_x', 'from_y', 'to_x', 'to_y',
            'delta_x', 'delta_y', 'delta_distance',
            'timestamp', 'notes'
        ]
        read_only_fields = ['delta_x', 'delta_y', 'delta_distance']


class ProjectSerializer(serializers.ModelSerializer):
    sheets = SheetSerializer(many=True, read_only=True)
    asset_count = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = [
            'id', 'name', 'description',
            'pixels_per_meter', 'scale_calibrated', 'coord_unit',
            'origin_x', 'origin_y', 'canvas_rotation',
            'asset_rotation', 'ref_asset_id', 'ref_pixel_x', 'ref_pixel_y',
            'sheets', 'asset_count',
            'created_at', 'updated_at'
        ]

    def get_asset_count(self, obj):
        return obj.assets.count()


class ProjectListSerializer(serializers.ModelSerializer):
    """Lighter serializer for list views."""
    sheet_count = serializers.SerializerMethodField()
    asset_count = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = ['id', 'name', 'description', 'sheet_count', 'asset_count', 'created_at']

    def get_sheet_count(self, obj):
        return obj.sheets.count()

    def get_asset_count(self, obj):
        return obj.assets.count()


class LinkSerializer(serializers.ModelSerializer):
    """Serializer for Link model with coordinate validation."""
    import_batch_name = serializers.CharField(source='import_batch.filename', read_only=True, default=None)
    point_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Link
        fields = [
            'id', 'project', 'link_id', 'name', 'coordinates',
            'color', 'width', 'opacity', 'link_type',
            'metadata', 'import_batch', 'import_batch_name', 'point_count',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['project']

    def validate_coordinates(self, value):
        """Validate coordinates is a list of [lon, lat] pairs."""
        if not isinstance(value, list):
            raise serializers.ValidationError("Coordinates must be a list")
        if len(value) < 2:
            raise serializers.ValidationError("Coordinates must have at least 2 points")

        for i, point in enumerate(value):
            if not isinstance(point, (list, tuple)):
                raise serializers.ValidationError(f"Point {i} must be a [lon, lat] array")
            if len(point) != 2:
                raise serializers.ValidationError(f"Point {i} must have exactly 2 values [lon, lat]")
            try:
                lon, lat = float(point[0]), float(point[1])
                # Basic range validation for geographic coordinates
                if not (-180 <= lon <= 180):
                    raise serializers.ValidationError(f"Point {i} longitude {lon} out of range [-180, 180]")
                if not (-90 <= lat <= 90):
                    raise serializers.ValidationError(f"Point {i} latitude {lat} out of range [-90, 90]")
            except (TypeError, ValueError):
                raise serializers.ValidationError(f"Point {i} must contain numeric values")
        return value
